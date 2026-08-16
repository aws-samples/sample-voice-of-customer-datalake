/**
 * VoC Chat context builder.
 * Ported from Python chat_stream_handler.py get_voc_chat_context().
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { getLanguageInstruction } from './language.js';
import type { SupportedLanguage } from './language.js';
import { PERSISTENT_QUERY_ERRORS } from './recent-feedback.js';

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

// The counters are validated at this boundary for the same reason the categories
// are: nothing between the admin UI and this read enforces a shape. `Number()`
// on a hand-edited or migrated `count: 'n/a'` yields NaN, and NaN is contagious
// under `+`, so one malformed row would take the whole window with it — dropping
// a category that has real feedback (`NaN > 0` is false) and handing the model a
// literal `Total Feedback Items: NaN`. A row that fails this parse contributes
// nothing and is reported, rather than poisoning its siblings.
const metricItemSchema = z.object({
  count: z.coerce.number().finite().optional(),
  value: z.coerce.number().finite().optional(),
}).passthrough();

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

// How many category partitions may be in flight at once. See fetchCategoryCounts
// for why this is neither serial nor unbounded; the ten-name default taxonomy is
// exactly one round either way.
const CATEGORY_QUERY_BATCH_SIZE = 10;

// Keyed by table, not one global entry. A container reads a single
// AGGREGATES_TABLE today (handler.ts), so the distinction is theoretical — but
// `aggregatesTable` is a parameter of every function here, so nothing in the
// types says it cannot vary, and keying the entry makes a mismatch impossible
// rather than merely unlikely. It also stops clearCategoryCache() from being the
// thing that keeps the invariant true.
const categoryCache = new Map<string, { names: string[]; expires: number }>();

/** Reset the container-level taxonomy cache (tests). */
export function clearCategoryCache(): void {
  categoryCache.clear();
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
 * What one metric partition's window came to, and whether reading it failed.
 *
 * The error name travels with the total rather than being logged where it
 * happens, for two reasons: a persistent failure hits every partition of the
 * table identically, so the turn must report it ONCE instead of sixteen times;
 * and a zero that came from a failed read is not a measured zero, so the prompt
 * has to be able to say the summary is incomplete rather than presenting it as
 * fact.
 */
interface MetricRead {
  total: number;
  errorName?: string;
  /** Which window came back short, for the one warning the caller logs. */
  partial?: string;
}

/** The readable counter rows of one page, summed. */
function sumMetricItems(
  items: Record<string, unknown>[] | undefined,
  metricKey: string,
): number {
  // Per-row, so one unreadable row costs one row. Coercing the page as a whole
  // would make the window NaN, which drops a category that has real feedback
  // (`NaN > 0` is false) and reaches the prompt as `Total Feedback Items: NaN`.
  const rows = (items ?? []).map((item) => metricItemSchema.safeParse(item));
  const skipped = rows.filter((row) => !row.success).length;
  if (skipped > 0) {
    console.warn(
      `sumMetricWindow: skipped ${skipped} unreadable counter row(s) in ${metricKey}; the window under-reports by that much`,
    );
  }
  return rows.reduce(
    (sum, row) => sum + (row.success ? row.data.count ?? row.data.value ?? 0 : 0),
    0,
  );
}

/**
 * One page of a metric window.
 *
 * The failure is returned rather than thrown so that the pages already read are
 * kept: a partition whose second page fails must report what its first page
 * measured. Throwing from inside the follow discarded all of it, which turned a
 * partial window into a confident zero — and a zero category is filtered out
 * entirely, so the Top Categories section rendered with nothing under it. The
 * per-day shape this replaced degraded gracefully (one failing day cost one
 * day), and losing that would be a regression.
 */
async function readMetricPage(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  bounds: { oldest: string; newest: string },
  startKey?: Record<string, unknown>,
): Promise<{ total: number; lastKey?: Record<string, unknown>; errorName?: string }> {
  try {
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
    return { total: sumMetricItems(resp.Items, metricKey), lastKey: resp.LastEvaluatedKey };
  } catch (error) {
    return { total: 0, errorName: error instanceof Error ? error.name : 'UnknownError' };
  }
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
 * quietly short answer. A page that FAILS is the same situation and takes the
 * same path: readMetricPage returns rather than throws, so the pages already
 * summed survive and only the unread remainder is missing.
 */
async function sumMetricWindow(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  bounds: { oldest: string; newest: string },
  pagesLeft: number,
  startKey?: Record<string, unknown>,
): Promise<MetricRead> {
  const page = await readMetricPage(docClient, aggregatesTable, metricKey, bounds, startKey);
  if (page.errorName) {
    // Whatever earlier pages counted is already in the caller's accumulator, and
    // this page's own rows are lost rather than the whole partition. The window
    // is named so the caller's single warning can say WHICH read came back short
    // — the payload metrics_handler.py::_query_metric_window carries, for the
    // same reason: nothing in the returned number can express that it is partial.
    return {
      total: page.total,
      errorName: page.errorName,
      partial: `${metricKey} over ${bounds.oldest}..${bounds.newest}`,
    };
  }
  if (!page.lastKey) return { total: page.total };
  if (pagesLeft <= 1) {
    console.warn(
      `sumMetricWindow: paging hit its bound for ${metricKey} over ${bounds.oldest}..${bounds.newest}; window is partial at ${page.total}`,
    );
    return { total: page.total };
  }
  const rest = await sumMetricWindow(
    docClient, aggregatesTable, metricKey, bounds, pagesLeft - 1, page.lastKey,
  );
  return { ...rest, total: page.total + rest.total };
}

async function sumDailyMetric(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  days: number,
): Promise<MetricRead> {
  const now = new Date();
  const bounds = { oldest: utcDateString(now, days - 1), newest: utcDateString(now, 0) };
  return sumMetricWindow(docClient, aggregatesTable, metricKey, bounds, days);
}

/**
 * Report each distinct read failure once for the turn, not once per partition,
 * and say whether the summary is degraded.
 *
 * A systemic failure — the names in PERSISTENT_QUERY_ERRORS, shared with
 * src/context/recent-feedback.ts — fails identically for every partition of the
 * same table, so sixteen warnings say nothing the first one did not.
 */
function reportMetricFailures(reads: MetricRead[]): string[] {
  const failures = new Map<string, string[]>();
  for (const read of reads) {
    if (!read.errorName) continue;
    const windows = failures.get(read.errorName) ?? [];
    windows.push(read.partial ?? 'unknown window');
    failures.set(read.errorName, windows);
  }
  for (const [errorName, windows] of failures) {
    const systemic = PERSISTENT_QUERY_ERRORS.has(errorName)
      ? ' — this name fails identically for every partition of the table'
      : '';
    console.warn(
      `buildVocChatContext: ${windows.length} metric window read(s) failed with ${errorName}${systemic}; the data summary is incomplete. Partial: ${windows.join('; ')}`,
    );
  }
  return [...failures.keys()];
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
 *
 * There is a FOURTH shape where the two sides deliberately differ: a stored
 * `categories` that is not a list at all (a dict, say, from a hand-edit or a
 * future writer). Python's `get_configured_categories` raises AttributeError on
 * it, so the metrics endpoint 500s; the Array.isArray guard below treats it as
 * not-configured instead. That is the deliberate choice for this surface — a
 * wrong-typed settings item must not be able to break a chat turn that is
 * already streaming — and it is the same trade the catch below makes. It is not
 * a shape either side should be relied on to normalise: the fix for a malformed
 * item is to fix the item.
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
      `readConfiguredCategories: settings read failed (${error instanceof Error ? error.name : 'UnknownError'}); using the default taxonomy`,
    );
    return { names: [...DEFAULT_CATEGORIES], ttl: CATEGORY_ERROR_CACHE_TTL_MS };
  }
}

async function getConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<string[]> {
  const now = Date.now();
  const cached = categoryCache.get(aggregatesTable);
  if (cached && now < cached.expires) {
    return cached.names;
  }
  const { names, ttl } = await readConfiguredCategories(docClient, aggregatesTable);
  categoryCache.set(aggregatesTable, { names, expires: now + ttl });
  return names;
}

async function fetchCategoryCounts(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  days: number,
): Promise<{ top: [string, number][]; reads: MetricRead[] }> {
  const categories = await getConfiguredCategories(docClient, aggregatesTable);
  // Concurrent but bounded, the same trade src/context/recent-feedback.ts makes
  // for its day queries (DAY_QUERY_BATCH_SIZE): awaiting each sum in turn put
  // one round trip per category in front of the first streamed token, and an
  // unbounded fan-out is no better — the taxonomy is operator-supplied and
  // uncapped (lambda/api/settings_handler.py::save_categories_config validates
  // neither its length nor its shape), so 200 configured names would mean 200
  // simultaneous queries from one invocation. A batch width of 10 keeps the
  // ten-name default at exactly one round while bounding the worst case.
  const batchStarts = Array.from(
    { length: Math.ceil(categories.length / CATEGORY_QUERY_BATCH_SIZE) },
    (_, index) => index * CATEGORY_QUERY_BATCH_SIZE,
  );
  const counted: [string, MetricRead][] = [];
  for (const start of batchStarts) {
    const batch = categories.slice(start, start + CATEGORY_QUERY_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (cat): Promise<[string, MetricRead]> => [
        cat,
        await sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_category#${cat}`, days),
      ]),
    );
    counted.push(...results);
  }
  const top = counted
    .map(([cat, read]): [string, number] => [cat, read.total])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return { top, reads: counted.map(([, read]) => read) };
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
  totals: { totalFeedback: number; urgentCount: number; failedReads: string[] },
  sentimentMap: Record<string, number>,
  topCategories: [string, number][],
  filters: { source?: string; category?: string; sentiment?: string },
): string {
  const { totalFeedback, urgentCount, failedReads } = totals;
  const pct = (n: number) => ((n / Math.max(totalFeedback, 1)) * 100).toFixed(1);
  const topCatLines = topCategories.map(([cat, count]) => `- ${cat}: ${count}`).join('\n');
  // A zero that came from a failed read is not a measured zero. Saying so is the
  // difference between the model reporting "no urgent issues" and reporting that
  // it could not tell — the same silent-confidence failure this module's history
  // is made of.
  const degraded = failedReads.length > 0
    ? `\n**NOTE:** Some metric reads failed (${failedReads.join(', ')}), so the figures below are incomplete and may under-report. Say so rather than presenting them as complete.\n`
    : '';

  const context = `## Current Data Summary (Last ${days} days)
${degraded}
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
  if (filters.source) activeFilters.push(`Source: ${filters.source}`);
  if (filters.category) activeFilters.push(`Category: ${filters.category}`);
  if (filters.sentiment) activeFilters.push(`Sentiment: ${filters.sentiment}`);
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
  const [totalRead, urgentRead, ...sentimentReads] = await Promise.all([
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#daily_total', days),
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#urgent', days),
    ...SENTIMENT_LABELS.map((s) =>
      sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_sentiment#${s}`, days),
    ),
  ]);

  const sentimentMap: Record<string, number> = {};
  for (const [i, label] of SENTIMENT_LABELS.entries()) {
    sentimentMap[label] = sentimentReads[i].total;
  }

  const categories = await fetchCategoryCounts(docClient, aggregatesTable, days);

  const totalFeedback = totalRead.total;
  const urgentCount = urgentRead.total;
  const failedReads = reportMetricFailures([
    totalRead, urgentRead, ...sentimentReads, ...categories.reads,
  ]);

  const systemPrompt = buildSystemPrompt(body.response_language);
  const dataContext = buildDataContext(
    days,
    { totalFeedback, urgentCount, failedReads },
    sentimentMap,
    categories.top,
    { source: sourceFilter, category: categoryFilter, sentiment: sentimentFilter },
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
