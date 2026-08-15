/**
 * VoC Chat context builder.
 * Ported from Python chat_stream_handler.py get_voc_chat_context().
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { getLanguageInstruction } from './language.js';
import type { SupportedLanguage } from './language.js';

const SENTIMENT_LABELS = ['positive', 'negative', 'neutral', 'mixed'] as const;

// The configured category taxonomy lives in the aggregates table under ONE key,
// written by the PUT /settings/categories handler (lambda/api/settings_handler.py,
// CATEGORIES_PK/CATEGORIES_SK) and read by the Python owner of this contract
// (lambda/shared/api.py::get_raw_categories_config). Any other key is never
// written, so reading it empties the Top Categories section on every turn.
// Pinned from Python by lambda/api/test/test_streaming_categories_lockstep.py.
const CATEGORY_SETTINGS_PK = 'SETTINGS#categories';
const CATEGORY_SETTINGS_SK = 'config';

// The daily counter partitions are named after the ENRICHMENT OUTPUT, which is
// the category NAME (see lambda/aggregator/handler.py) — hence `name` here, not
// any internal identifier. `name` is the only required property: a configured
// category that carries no `id` must survive the parse, because the writer does
// not guarantee one.
const categoryItemSchema = z.object({ name: z.string() }).passthrough();

// Mirrors lambda/shared/api.py::DEFAULT_CATEGORIES. When nothing is configured,
// get_configured_categories() falls back to this list, and the enrichment
// prompt uses the same names (lambda/processor/handler.py::DEFAULT_CATEGORIES),
// so the counters exist under these names. Falling back to an empty array here
// would report an empty section where the metrics surface reports counts.
// Note the admin UI's own GET /settings/categories still answers `[]` for an
// unconfigured deployment (lambda/api/settings_handler.py::get_categories_config);
// aligning that third surface is deliberately out of this module's scope.
const DEFAULT_CATEGORIES = [
  'delivery', 'customer_support', 'product_quality', 'pricing',
  'website', 'app', 'billing', 'returns', 'communication', 'other',
] as const;

// The taxonomy changes at human speed, so re-reading it on every chat turn buys
// nothing and sits in front of time-to-first-token. 300s matches
// CATEGORIES_CACHE_TTL in lambda/shared/api.py, whose reader this one mirrors.
// A failed read caches for much less, so a throttling blip cannot pin streaming
// chat to the default taxonomy for a full five minutes (the shape used by
// src/bedrock/model-override.ts).
const CATEGORY_CACHE_TTL_MS = 300_000;
const CATEGORY_ERROR_CACHE_TTL_MS = 10_000;

const categoryCache: { names: string[] | null; expires: number } = { names: null, expires: 0 };

/** Reset the container-level taxonomy cache (tests). */
export function clearCategoryCache(): void {
  categoryCache.names = null;
  categoryCache.expires = 0;
}

interface VocChatContext {
  systemPrompt: string;
  userMessage: string;
  metadata: {
    total_feedback: number;
    days_analyzed: number;
    urgent_count: number;
    filters: {
      source?: string;
      category?: string;
      sentiment?: string;
      days: number;
      dateBasis?: 'imported' | 'review';
    };
  };
}

function parseContextFilters(contextHint: string): Record<string, string> {
  const filters: Record<string, string> = {};
  const patterns: Record<string, RegExp> = {
    source: /Source:\s*([^.]+)/,
    category: /Category:\s*([^.]+)/,
    sentiment: /Sentiment:\s*([^.]+)/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = pattern.exec(contextHint);
    if (match?.[1]) filters[key] = match[1].trim();
  }
  return filters;
}

function utcDateString(now: Date, daysAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * One metric partition's trailing window, summed, newest date inclusive.
 *
 * `sk` is 'YYYY-MM-DD' and ISO dates sort lexicographically, so a window is a
 * contiguous sort-key range that BETWEEN bounds server-side: a fixed number of
 * requests regardless of `days`, not one query per day. This mirrors
 * lambda/api/metrics_handler.py::_query_metric_window, which was deliberately
 * moved off per-day reads for exactly that reason — and it matters most here,
 * because this sum sits in front of the first streamed token.
 *
 * Paging is bounded rather than `while (true)`: one date yields at most one item
 * and an unfiltered page yields at least one, so a window of `days` dates cannot
 * span more than `days` pages. Exhausting the bound means that invariant no
 * longer holds, so the window really is partial — log it instead of returning a
 * quietly short answer.
 */
async function sumMetricWindow(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  bounds: { oldest: string; newest: string },
  pagesLeft: number,
  startKey?: Record<string, unknown>,
): Promise<number> {
  const resp = await docClient.send(
    new QueryCommand({
      TableName: aggregatesTable,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :oldest AND :newest',
      ExpressionAttributeValues: {
        ':pk': metricKey,
        ':oldest': bounds.oldest,
        ':newest': bounds.newest,
      },
      ExclusiveStartKey: startKey,
    }),
  );
  const total = (resp.Items ?? []).reduce(
    (sum: number, item) => sum + Number(item.count ?? item.value ?? 0),
    0,
  );
  const lastKey = resp.LastEvaluatedKey;
  if (!lastKey) return total;
  if (pagesLeft <= 1) {
    console.warn(`sumMetricWindow: paging hit its bound for ${metricKey}; window is partial`);
    return total;
  }
  return total + (await sumMetricWindow(
    docClient, aggregatesTable, metricKey, bounds, pagesLeft - 1, lastKey,
  ));
}

async function sumDailyMetric(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  days: number,
): Promise<number> {
  const now = new Date();
  const bounds = { oldest: utcDateString(now, days - 1), newest: utcDateString(now, 0) };
  try {
    return await sumMetricWindow(docClient, aggregatesTable, metricKey, bounds, days);
  } catch (error) {
    console.warn(
      `sumMetricWindow: read failed for ${metricKey}: ${error instanceof Error ? error.name : 'UnknownError'}`,
    );
    return 0;
  }
}

/**
 * The names in a stored `categories` list, or the empty array when the stored
 * list is present but names nothing.
 *
 * A configured-but-nameless list yields [] rather than the defaults, exactly as
 * Python does: `get_raw_categories_config` returns the raw list, and
 * `get_configured_categories` sees a truthy list so never reaches its fallback,
 * leaving the name filter to produce [].
 */
function namesFromStoredList(cats: unknown[]): string[] {
  return cats
    .map((c: unknown) => {
      const parsed = categoryItemSchema.safeParse(c);
      return parsed.success ? parsed.data.name : '';
    })
    .filter(Boolean);
}

/**
 * The configured category names, matching lambda/shared/api.py
 * (`get_raw_categories_config` + `get_configured_categories`) item-for-item:
 * one key, the `name` field, and DEFAULT_CATEGORIES when nothing is configured.
 *
 * The three stored shapes Python treats as "not configured" — item absent,
 * `categories` missing, `categories: []` — all fall through to the defaults
 * here too, because `item.get('categories')` is falsy for an empty list.
 */
async function readConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<{ names: string[]; ttl: number }> {
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: aggregatesTable,
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: { ':pk': CATEGORY_SETTINGS_PK, ':sk': CATEGORY_SETTINGS_SK },
      }),
    );
    const items = resp.Items ?? [];
    const firstItem: Record<string, unknown> = items.length > 0 ? items[0] : {};
    const cats: unknown = firstItem.categories;
    if (Array.isArray(cats) && cats.length > 0) {
      return { names: namesFromStoredList(cats), ttl: CATEGORY_CACHE_TTL_MS };
    }
    return { names: [...DEFAULT_CATEGORIES], ttl: CATEGORY_CACHE_TTL_MS };
  } catch (error) {
    // A failed read is NOT the same as "nothing configured": a tenant that has
    // configured a taxonomy is briefly described by the default one instead.
    // Python's reader makes the same trade (it logs and falls through to the
    // fallback), so the two surfaces still agree; the short error TTL keeps the
    // window small rather than caching a wrong answer for five minutes.
    console.warn(
      `getConfiguredCategories: settings read failed (${error instanceof Error ? error.name : 'UnknownError'}); using the default taxonomy`,
    );
    return { names: [...DEFAULT_CATEGORIES], ttl: CATEGORY_ERROR_CACHE_TTL_MS };
  }
}

async function getConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<string[]> {
  const now = Date.now();
  if (categoryCache.names !== null && now < categoryCache.expires) {
    return categoryCache.names;
  }
  const { names, ttl } = await readConfiguredCategories(docClient, aggregatesTable);
  categoryCache.names = names;
  categoryCache.expires = now + ttl;
  return names;
}

async function fetchCategoryCounts(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  days: number,
): Promise<[string, number][]> {
  const categories = await getConfiguredCategories(docClient, aggregatesTable);
  // Concurrent, not serial: the taxonomy has ten names by default, and awaiting
  // each sum in turn put ten sequential round trips in front of the first
  // streamed token.
  const counts = await Promise.all(
    categories.map(async (cat): Promise<[string, number]> => [
      cat,
      await sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_category#${cat}`, days),
    ]),
  );
  return counts
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

function buildSystemPrompt(responseLanguage?: SupportedLanguage): string {
  const base = `You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.

You have access to two tools:
- "search_feedback": search and retrieve customer feedback from various sources (web scrapers, manual imports, S3 imports, etc.).
- "create_project": turn the insights from this conversation into a new project, pre-filling its product context.

IMPORTANT GUIDELINES:
1. ONLY use the search_feedback tool when the user's question is specifically about customer feedback, reviews, or customer opinions
2. For general questions, greetings, or non-feedback topics, respond directly WITHOUT using the tool
3. When you DO use the tool, be specific with your search query to get relevant results
4. For broad questions (summarize, count, trends, "top/most urgent/biggest issues"), call search_feedback with mode="aggregate" — it returns stats over the ENTIRE dataset in one call. Do NOT repeatedly page through individual items.
5. To find urgent/critical feedback, pass urgency="high" and/or sort_by="urgency". The query field is a literal substring match on review text, so words like "urgent" in the query will NOT filter by urgency level.
6. Base your answers on the actual data returned by the tool
7. Quote actual customer feedback when relevant
8. Highlight urgent issues that need attention
9. Provide actionable recommendations based on the data
10. When the user asks to turn findings into a project ("make/create a project", "프로젝트 만들어줘"), call create_project. First make sure you've analyzed the relevant feedback (search_feedback) so you can draft a grounded name, description, and product-context fields (product_name, one_liner, target_users, problem_solved, key_features). Only fill fields you can support with the actual feedback — omit the rest rather than inventing.

Format your responses clearly with bullet points or numbered lists when appropriate.`;

  const langInstruction = getLanguageInstruction(responseLanguage);
  return langInstruction ? `${base}\n\n${langInstruction}` : base;
}

function buildDataContext(
  days: number,
  totalFeedback: number,
  urgentCount: number,
  sentimentMap: Record<string, number>,
  topCategories: [string, number][],
  sourceFilter?: string,
  categoryFilter?: string,
  sentimentFilter?: string,
): string {
  const pct = (n: number) => ((n / Math.max(totalFeedback, 1)) * 100).toFixed(1);
  const topCatLines = topCategories.map(([cat, count]) => `- ${cat}: ${count}`).join('\n');

  const context = `## Current Data Summary (Last ${days} days)

**Total Feedback Items:** ${totalFeedback}
**Urgent Issues:** ${urgentCount}

**Sentiment Breakdown:**
- Positive: ${sentimentMap.positive} (${pct(sentimentMap.positive)}%)
- Neutral: ${sentimentMap.neutral} (${pct(sentimentMap.neutral)}%)
- Negative: ${sentimentMap.negative} (${pct(sentimentMap.negative)}%)
- Mixed: ${sentimentMap.mixed} (${pct(sentimentMap.mixed)}%)

**Top Categories:**
${topCatLines}
`;

  const activeFilters: string[] = [];
  if (sourceFilter) activeFilters.push(`Source: ${sourceFilter}`);
  if (categoryFilter) activeFilters.push(`Category: ${categoryFilter}`);
  if (sentimentFilter) activeFilters.push(`Sentiment: ${sentimentFilter}`);
  if (activeFilters.length > 0) {
    return `${context}\n## Active Filters: ${activeFilters.join(', ')}\nWhen using the search_feedback tool, apply these filters.\n`;
  }
  return context;
}

export async function buildVocChatContext(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  body: {
    message: string;
    context?: string;
    days?: number;
    date_basis?: 'imported' | 'review';
    response_language?: SupportedLanguage;
  },
): Promise<VocChatContext> {
  const message = body.message;
  const contextHint = body.context ?? '';
  const days = Math.min(Math.max(body.days ?? 7, 1), 365);

  const parsed = parseContextFilters(contextHint);
  const sourceFilter = parsed.source;
  const categoryFilter = parsed.category;
  const sentimentFilter = parsed.sentiment;

  // Fetch metrics in parallel
  const [totalFeedback, urgentCount, ...sentimentCounts] = await Promise.all([
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#daily_total', days),
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#urgent', days),
    ...SENTIMENT_LABELS.map((s) =>
      sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_sentiment#${s}`, days),
    ),
  ]);

  const sentimentMap: Record<string, number> = {};
  for (const [i, label] of SENTIMENT_LABELS.entries()) {
    sentimentMap[label] = sentimentCounts[i];
  }

  const topCategories = await fetchCategoryCounts(docClient, aggregatesTable, days);

  const systemPrompt = buildSystemPrompt(body.response_language);
  const dataContext = buildDataContext(
    days, totalFeedback, urgentCount, sentimentMap, topCategories,
    sourceFilter, categoryFilter, sentimentFilter,
  );
  const userMessage = `${dataContext}\n\n---\n\nUser Question: ${message}`;

  return {
    systemPrompt,
    userMessage,
    metadata: {
      total_feedback: totalFeedback,
      days_analyzed: days,
      urgent_count: urgentCount,
      filters: {
        source: sourceFilter,
        category: categoryFilter,
        sentiment: sentimentFilter,
        days,
        // Rides through to the search tool; the aggregate headline numbers
        // above stay import-bucketed (they come from daily aggregates).
        dateBasis: body.date_basis,
      },
    },
  };
}
