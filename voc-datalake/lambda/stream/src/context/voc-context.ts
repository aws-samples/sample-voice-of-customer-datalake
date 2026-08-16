/**
 * VoC Chat context builder.
 * Ported from Python chat_stream_handler.py get_voc_chat_context().
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { getLanguageInstruction } from './language.js';
import type { SupportedLanguage } from './language.js';
import { PERSISTENT_QUERY_ERRORS } from './query-errors.js';

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
//
// The union in front of the coercion is a decision about what is NOT a count,
// and it is a decision rather than an accident. `z.coerce` runs Number() first,
// and Number() answers 0 for several things that hold no count at all: null, an
// empty string, a whitespace string, false. Each would then be counted as a
// MEASURED zero, and none of them is one — nobody knows what that row held. So
// the value must already be a number, or a string with something in it, and the
// coercion only ever sees those; everything else lands in `skippedRows`, where it
// makes the turn say the figures are incomplete instead of quietly reading zero.
// (`.trim()` before `.min(1)` is what rejects ' ' as well as ''; a padded numeric
// string like ' 5 ' still parses, since DynamoDB stores what it was given.)
//
// Booleans are rejected by the UNION, not by the coercion, and the distinction
// matters to anyone tempted to simplify this to `z.coerce.number().finite()` on
// the grounds that the coercion handles everything: a boolean is not a number in
// JavaScript, so `z.number()` rejects it here — but `Number(false)` is 0 and
// `Number(true)` is 1, so under a bare coercion a `count: true` row would be
// counted as one item of feedback that nobody ever recorded. Simplifying this
// away reinstates exactly the class of defect the whole schema exists for.
//
// `.finite()` is the last gate, and it covers the other end: a stored 1e999
// parses as Infinity, which would render in the prompt as `Infinity` (and make
// every sentiment percentage 0.0%). It lands in `skippedRows` instead.
const counterValue = z.union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number().finite());

const metricItemSchema = z.object({
  count: counterValue.optional(),
  value: counterValue.optional(),
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
// `errorName` is cached WITH the entry, not recomputed per turn. A turn served
// from the short error entry is describing the tenant with a taxonomy it never
// configured just as much as the turn that did the failed read, so it has to
// report the same thing — caching the names while dropping the reason would make
// the CATEGORY_ERROR_CACHE_TTL_MS window read as healthy.
const categoryCache = new Map<
  string,
  { names: string[]; expires: number; errorName?: string }
>();

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
 * What one metric partition's window came to, and every way it may be short.
 *
 * There are exactly three ways: the read failed, some rows would not parse, or
 * paging hit its bound. All three travel with the total rather than being logged
 * where they happen, for two reasons. A systemic cause — a denied table, a
 * migration that wrote strings, a fan-out wider than the bound — hits every
 * partition identically, so the turn must report it ONCE instead of sixteen
 * times; and a number that is short is not a measured number, so the prompt has
 * to be able to say the summary is incomplete rather than presenting it as fact.
 * Only the caller sees the whole turn, so only the caller can do either.
 */
interface MetricRead {
  /** What the readable rows of the pages that were read came to. */
  total: number;
  /** Which window this is, so one warning per cause can name the reads it covers. */
  window: string;
  /** Set when a page read failed; `total` is then only what earlier pages held. */
  errorName?: string;
  /** How many rows would not parse, so `total` is short by their counts. */
  skippedRows: number;
  /** Set when paging hit its bound, so an unread remainder is missing. */
  boundExhausted?: boolean;
}

/**
 * The readable counter rows of one page, summed, and how many were not readable.
 *
 * The count is returned rather than warned about here: this runs once per page
 * per partition, and a systemic cause makes every one of those pages fail the
 * same way. Reporting is the caller's job for that reason.
 */
function sumMetricItems(
  items: Record<string, unknown>[] | undefined,
): { total: number; skipped: number } {
  // Per-row, so one unreadable row costs one row. Coercing the page as a whole
  // would make the window NaN, which drops a category that has real feedback
  // (`NaN > 0` is false) and reaches the prompt as `Total Feedback Items: NaN`.
  const rows = (items ?? []).map((item) => metricItemSchema.safeParse(item));
  return {
    total: rows.reduce(
      (sum, row) => sum + (row.success ? row.data.count ?? row.data.value ?? 0 : 0),
      0,
    ),
    skipped: rows.filter((row) => !row.success).length,
  };
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
): Promise<{
  total: number;
  skipped: number;
  lastKey?: Record<string, unknown>;
  errorName?: string;
}> {
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
    return { ...sumMetricItems(resp.Items), lastKey: resp.LastEvaluatedKey };
  } catch (error) {
    return {
      total: 0,
      skipped: 0,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    };
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
 * longer holds, so the window really is partial — say so on the returned value
 * instead of returning a quietly short answer. A page that FAILS is the same
 * situation and takes the same path: readMetricPage returns rather than throws,
 * so the pages already summed survive and only the unread remainder is missing.
 *
 * Every shortfall is reported by the CALLER, once per cause for the whole turn.
 * Warning here instead was the mistake this shape replaces: this function runs
 * once per partition, and a systemic cause makes all sixteen say the same thing.
 */
async function sumMetricWindow(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  bounds: { oldest: string; newest: string },
  pagesLeft: number,
  startKey?: Record<string, unknown>,
): Promise<MetricRead> {
  // Named on every return, not just the short ones, so the caller's one warning
  // per cause can say WHICH reads came back short — the payload
  // metrics_handler.py::_query_metric_window carries, for the same reason:
  // nothing in the returned number can express that it is partial.
  const window = `${metricKey} over ${bounds.oldest}..${bounds.newest}`;
  const page = await readMetricPage(docClient, aggregatesTable, metricKey, bounds, startKey);
  if (page.errorName) {
    // Whatever earlier pages counted is already in the caller's accumulator, and
    // this page's own rows are lost rather than the whole partition.
    return {
      total: page.total, window, skippedRows: page.skipped, errorName: page.errorName,
    };
  }
  if (!page.lastKey) return { total: page.total, window, skippedRows: page.skipped };
  if (pagesLeft <= 1) {
    return {
      total: page.total, window, skippedRows: page.skipped, boundExhausted: true,
    };
  }
  const rest = await sumMetricWindow(
    docClient, aggregatesTable, metricKey, bounds, pagesLeft - 1, page.lastKey,
  );
  return {
    ...rest,
    window,
    total: page.total + rest.total,
    skippedRows: page.skipped + rest.skippedRows,
  };
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
 * Report each way this turn's windows came back short ONCE, and answer whether
 * the summary is degraded.
 *
 * Three causes, one report each. A read that failed, rows that would not parse
 * and paging that hit its bound all leave a total lower than the truth, and each
 * has a systemic form that hits every partition of the table identically — the
 * names in PERSISTENT_QUERY_ERRORS (src/context/query-errors.ts, shared with
 * recent-feedback.ts, which reached the same conclusion for its own fan-out), a
 * migration that wrote strings into `count`, a taxonomy wider than the page
 * bound. Sixteen warnings say nothing the first one did, so the aggregation
 * happens here, where the whole turn is visible, and not in the per-page read.
 *
 * The returned flag is the other half, and the more important one: a total that
 * is short must not be rendered as a measured fact. All three causes feed it, so
 * "the figures are incomplete" means one thing.
 */
function reportMetricFailures(reads: MetricRead[]): boolean {
  const failures = new Map<string, string[]>();
  for (const read of reads) {
    if (!read.errorName) continue;
    const windows = failures.get(read.errorName) ?? [];
    windows.push(read.window);
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

  const withSkips = reads.filter((read) => read.skippedRows > 0);
  if (withSkips.length > 0) {
    const rows = withSkips.reduce((sum, read) => sum + read.skippedRows, 0);
    console.warn(
      `buildVocChatContext: skipped ${rows} unreadable counter row(s) across ${withSkips.length} metric window(s); those windows under-report by that much. Partial: ${withSkips.map((read) => read.window).join('; ')}`,
    );
  }

  const exhausted = reads.filter((read) => read.boundExhausted);
  if (exhausted.length > 0) {
    console.warn(
      `buildVocChatContext: paging hit its bound for ${exhausted.length} metric window(s), so an unread remainder is missing. Partial: ${exhausted.map((read) => read.window).join('; ')}`,
    );
  }

  return failures.size > 0 || withSkips.length > 0 || exhausted.length > 0;
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
 *
 * A read that FAILED is reported on the returned value (`errorName`) rather than
 * only logged, because it is the fourth way this turn can hand the model
 * something that was not measured — and the most consequential one. The other
 * three make a number short; this one substitutes the whole taxonomy, so a
 * tenant who configured `delivery_ops`, `kyc`, `fees` gets counts for ten
 * partitions that are not theirs, plausibly all zero, and the section still
 * renders as authoritative. It therefore feeds the same degraded note the metric
 * shortfalls do.
 */
async function readConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<{ names: string[]; ttl: number; errorName?: string }> {
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
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.warn(
      `readConfiguredCategories: settings read failed (${errorName}); using the default taxonomy`,
    );
    return { names: [...DEFAULT_CATEGORIES], ttl: CATEGORY_ERROR_CACHE_TTL_MS, errorName };
  }
}

async function getConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<{ names: string[]; errorName?: string }> {
  const now = Date.now();
  const cached = categoryCache.get(aggregatesTable);
  if (cached && now < cached.expires) {
    return { names: cached.names, errorName: cached.errorName };
  }
  const { names, ttl, errorName } = await readConfiguredCategories(docClient, aggregatesTable);
  categoryCache.set(aggregatesTable, { names, expires: now + ttl, errorName });
  return { names, errorName };
}

async function fetchCategoryCounts(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  days: number,
): Promise<{ top: [string, number][]; reads: MetricRead[]; taxonomyErrorName?: string }> {
  const { names: categories, errorName: taxonomyErrorName } = await getConfiguredCategories(
    docClient, aggregatesTable,
  );
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
  return { top, reads: counted.map(([, read]) => read), taxonomyErrorName };
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
  totals: { totalFeedback: number; urgentCount: number; degraded: boolean },
  sentimentMap: Record<string, number>,
  topCategories: [string, number][],
  filters: { source?: string; category?: string; sentiment?: string },
): string {
  const { totalFeedback, urgentCount, degraded } = totals;
  const pct = (n: number) => ((n / Math.max(totalFeedback, 1)) * 100).toFixed(1);
  const topCatLines = topCategories.map(([cat, count]) => `- ${cat}: ${count}`).join('\n');
  // A number that came back short is not a measured number. Saying so is the
  // difference between the model reporting "no urgent issues" and reporting that
  // it could not tell — the same silent-confidence failure this module's history
  // is made of.
  //
  // What this sentence must NOT carry is the CAUSE. `error.name` is
  // infrastructure detail: AccessDeniedException tells whoever reads the answer
  // that this Lambda's IAM role is missing a grant, ResourceNotFoundException
  // that a table is absent or misnamed. Neither is actionable for them, and this
  // is the one sentence in the section the model is explicitly told to relay, so
  // interpolating the name is inviting it out to an end user. The operator
  // channel for it already exists and is strictly better: reportMetricFailures
  // logs the name together with the window bounds it applies to.
  //
  // English is deliberate, as it is for the field labels below: this is prompt
  // text, not UI copy. buildSystemPrompt instructs the model to answer in
  // response_language, so the model relays this fact in the user's language —
  // translating the prompt would change nothing the user reads.
  const degradedNote = degraded
    ? '\n**NOTE:** Some metric reads did not complete, so the figures below are incomplete and may under-report. Say so rather than presenting them as complete.\n'
    : '';

  const context = `## Current Data Summary (Last ${days} days)
${degradedNote}
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
  // A failed TAXONOMY read degrades the turn too, and it is not a MetricRead: it
  // substitutes the default names for the tenant's own, so the counts under Top
  // Categories are for partitions that may not be theirs. reportMetricFailures
  // has already logged its own warning (with the error name, which stays out of
  // the prompt), so only the flag is ORed in here.
  const degraded = reportMetricFailures([
    totalRead, urgentRead, ...sentimentReads, ...categories.reads,
  ]) || categories.taxonomyErrorName !== undefined;

  const systemPrompt = buildSystemPrompt(body.response_language);
  const dataContext = buildDataContext(
    days,
    { totalFeedback, urgentCount, degraded },
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
