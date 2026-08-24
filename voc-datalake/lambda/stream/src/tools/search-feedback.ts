/**
 * search_feedback tool implementation.
 * Ported from Python chat_stream_handler.py.
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError } from '../lib/errors.js';
import { FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX } from '../indexes.js';

const searchInputSchema = z.object({
  query: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  sentiment: z.string().optional(),
  urgency: z.string().optional(),
  limit: z.number().optional(),
  // 'aggregate' returns distribution stats over ALL matches in one call
  // (counts by urgency/sentiment/category + a few examples) instead of a
  // capped list — answers "summarize all" / "top issues" without looping.
  mode: z.enum(['list', 'aggregate']).optional(),
  // 'urgency' sorts matches high→medium→low (most negative first within a
  // tier) so "most urgent" surfaces the right items even past the list cap.
  sort_by: z.enum(['recent', 'urgency']).optional(),
}).passthrough();

const URGENCY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function urgencyRank(item: FeedbackItem): number {
  return URGENCY_RANK[item.urgency ?? ''] ?? 0;
}

// high→medium→low; within a tier, most negative sentiment first, then newest.
function compareByUrgency(a: FeedbackItem, b: FeedbackItem): number {
  const byUrgency = urgencyRank(b) - urgencyRank(a);
  if (byUrgency !== 0) return byUrgency;
  const sa = a.sentiment_score ?? 0;
  const sb = b.sentiment_score ?? 0;
  if (sa !== sb) return sa - sb;
  return (b.date ?? '').localeCompare(a.date ?? '');
}

type SearchInput = z.infer<typeof searchInputSchema>;

interface ContextFilters {
  source?: string;
  category?: string;
  sentiment?: string;
  days?: number;
  /** 'imported' (default) or 'review' — which date the days window uses. */
  dateBasis?: 'imported' | 'review';
}

const feedbackItemSchema = z.object({
  feedback_id: z.string().optional(),
  source_platform: z.string().optional(),
  source_created_at: z.string().optional(),
  sentiment_label: z.string().optional(),
  // The ingestion pipeline stores these numerics as DynamoDB strings (S) for
  // ~all items, so a strict z.number() rejected nearly every row — which made
  // fetchCandidatesByDate silently drop them all and every search return 0
  // results. coerce accepts both "0.95"/0.95 and "5"/5.
  sentiment_score: z.coerce.number().optional(),
  category: z.string().optional(),
  rating: z.coerce.number().nullable().optional(),
  original_text: z.string().optional(),
  title: z.string().optional(),
  problem_summary: z.string().optional(),
  date: z.string().optional(),
  urgency: z.string().optional(),
}).passthrough();

type FeedbackItem = z.infer<typeof feedbackItemSchema>;

/**
 * What the tool hands back.
 *
 * `isPartial` is true when the candidate scan was truncated, so `items` and the
 * counts in `formatted` describe a sample rather than the whole window. The
 * same warning is written into `formatted` (see `truncationNotice`) because the
 * consumer here is the model, which only reads the prose — a flag that never
 * reaches the text would change nothing for the user.
 */
interface SearchFeedbackResult {
  items: FeedbackItem[];
  formatted: string;
  isPartial: boolean;
}

// ── Filtering ──

// Shape guard: a malformed source_created_at ("unavailable") would compare
// lexicographically above any YYYY-MM-DD cutoff and sneak through.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The YYYY-MM-DD date the window applies to for one item. 'review' uses the
 * date the customer wrote the feedback (source_created_at), falling back to
 * the import date when missing/malformed; 'imported' uses the import date.
 * Mirrors lambda/shared/feedback.py::basis_date.
 */
function itemBasisDate(item: FeedbackItem, dateBasis?: 'imported' | 'review'): string {
  if (dateBasis === 'review') {
    const sourceCreated = (item.source_created_at ?? '').slice(0, 10);
    if (ISO_DATE_RE.test(sourceCreated)) return sourceCreated;
  }
  return item.date ?? '';
}

function passesDateFilter(
  item: FeedbackItem,
  cutoffDate: string,
  dateBasis?: 'imported' | 'review',
): boolean {
  return itemBasisDate(item, dateBasis) >= cutoffDate;
}

function passesFieldFilters(item: FeedbackItem, filters: Record<string, string | undefined>): boolean {
  if (filters.source && item.source_platform !== filters.source) return false;
  if (filters.sentiment && item.sentiment_label !== filters.sentiment) return false;
  if (filters.category && item.category !== filters.category) return false;
  if (filters.urgency && item.urgency !== filters.urgency) return false;
  return true;
}

function passesTextSearch(item: FeedbackItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const text = (item.original_text ?? '').toLowerCase();
  const title = (item.title ?? '').toLowerCase();
  const problem = (item.problem_summary ?? '').toLowerCase();
  return text.includes(q) || title.includes(q) || problem.includes(q);
}

function matchesFeedbackItem(
  item: FeedbackItem,
  query: string,
  filters: Record<string, string | undefined>,
  cutoffDate: string,
  dateBasis?: 'imported' | 'review',
): boolean {
  return passesDateFilter(item, cutoffDate, dateBasis)
    && passesFieldFilters(item, filters)
    && passesTextSearch(item, query);
}

// ── Query helpers ──

async function lookupByFeedbackId(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  feedbackId: string,
): Promise<SearchFeedbackResult | null> {
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: feedbackTable,
        IndexName: FEEDBACK_BY_ID_INDEX,
        KeyConditionExpression: 'feedback_id = :fid',
        ExpressionAttributeValues: { ':fid': feedbackId.toLowerCase().trim() },
        Limit: 1,
      }),
    );
    const items = (resp.Items ?? []).map((raw) => feedbackItemSchema.parse(raw));
    if (items.length > 0) {
      // A direct ID hit reads one row by key: nothing was truncated.
      return { items, formatted: formatToolResults(items), isPartial: false };
    }
  } catch {
    // Fall through to date-based search
  }
  return null;
}

/**
 * Upper bound on candidates collected across all days. A DynamoDB Query caps
 * each page at 1MB (often far fewer than 1000 large items), so we MUST follow
 * LastEvaluatedKey to page through a day — otherwise a day with thousands of
 * rows is silently truncated to the first ~500 (this caused "987 negative but
 * tool only saw 116"). Bound the total so aggregate mode can summarize the full
 * set without unbounded memory/time on a huge table.
 *
 * Deliberately NOT pinned to `metrics_handler.CANDIDATES_SOFT_CAP` (1000): the
 * two budget different consumers — a model reading one prose digest in a single
 * turn vs. a paginating HTTP client — so they are separate decisions, not one
 * rule with two copies. Exported so tests can size a fixture from it instead of
 * hard-coding a literal that goes stale when this number moves.
 */
export const MAX_CANDIDATES = 10000;

/**
 * How many days back the date scan may reach, however many the chat context
 * asks for. Mirror of `MAX_LOOKBACK_DAYS` in lambda/shared/feedback.py, which
 * the REST feedback routes spend as `days=min(days, MAX_LOOKBACK_DAYS)`.
 *
 * This runtime cannot import the Python constant, so the two are pinned
 * together by lambda/shared/test/test_lookback_window_lockstep.py: it parses
 * the declaration below and fails when the numbers diverge. It read 30 here
 * against 90 there for months, so the chat tool answered "last quarter" from a
 * month of feedback while the REST route used the full window.
 *
 * Spent in exactly one place — `resolveSearchParams` — so the scan bound, the
 * cutoff filter and the notice text cannot disagree about which window this
 * answer covers. `metrics_handler.py` carries the same warning from having had
 * that bug: "This read `min(days, 30)` while `cutoff_date` above was computed
 * from the caller's full `days`, so the two disagreed."
 *
 * Keep the literal on one line as `export const MAX_LOOKBACK_DAYS = <n>` — the
 * lockstep test parses this text.
 */
export const MAX_LOOKBACK_DAYS = 90;

/**
 * Why an answer covers less than the window the caller asked about.
 *
 * Each cause gets its own clause in the model-facing notice, because a notice
 * that names one cause for all of them misattributes the rest: "the candidate
 * cap" is a wrong explanation for a throttled partition or a clamped window.
 */
type TruncationReason =
  | 'windowClamped'
  | 'dayPartiallyRead'
  | 'daysUnread'
  | 'dayReadFailed'
  | 'rowsDropped';

/** What one day's read cost the answer: pages left unread, rows dropped. */
interface DayReadOutcome {
  truncated: boolean;
  dropped: number;
}

/**
 * Page through one day's GSI partition via LastEvaluatedKey (not just the
 * first page), appending valid rows to `candidates`. Per-row safeParse: a
 * single malformed item must not throw and discard the whole day's results.
 * Recursion depth = pages in the day's partition; the MAX_CANDIDATES check
 * stops early only as parsed rows accumulate (a day of entirely malformed
 * rows still pages to its end, same as the previous do/while).
 *
 * `truncated` is true when the day still had pages left but MAX_CANDIDATES
 * stopped the walk. `dropped` counts rows safeParse rejected: they are rows the
 * answer does not contain, so the caller reports them too rather than
 * presenting a window every row of which was discarded as fully read.
 */
async function fetchDayPages(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  dateStr: string,
  candidates: FeedbackItem[],
  startKey?: Record<string, unknown>,
): Promise<DayReadOutcome> {
  const resp = await docClient.send(
    new QueryCommand({
      TableName: feedbackTable,
      IndexName: FEEDBACK_BY_DATE_INDEX,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `DATE#${dateStr}` },
      ScanIndexForward: false,
      ExclusiveStartKey: startKey,
    }),
  );
  const parsedRows = (resp.Items ?? []).map((raw) => feedbackItemSchema.safeParse(raw));
  for (const parsed of parsedRows) {
    if (parsed.success) candidates.push(parsed.data);
  }
  const dropped = parsedRows.filter((parsed) => !parsed.success).length;
  if (!resp.LastEvaluatedKey) return { truncated: false, dropped };
  if (candidates.length >= MAX_CANDIDATES) return { truncated: true, dropped };
  const rest = await fetchDayPages(
    docClient, feedbackTable, dateStr, candidates, resp.LastEvaluatedKey,
  );
  return { truncated: rest.truncated, dropped: dropped + rest.dropped };
}

/**
 * Collect candidates day by day, newest first, over exactly `days` partitions.
 *
 * `days` must already be clamped to MAX_LOOKBACK_DAYS — `resolveSearchParams`
 * is the single place that does it, so this loop's bound is the same number the
 * cutoff filter uses. Clamping again here is what made the two disagree before.
 *
 * Returns `{ candidates, reasons }`: every way this scan fell short of the
 * window it was asked for, so the caller can say which. Mirrors the Python
 * route's `_scan_recent_items` in lambda/api/metrics_handler.py, which returns
 * `(items, is_partial)` for the same reason — with one addition, because this
 * runtime has failure modes Python's does not: `_query_partition` propagates a
 * failed read while this loop survives it, so a survived failure must be
 * REPORTED (the rule voc-context.ts states for its metric pages) rather than
 * leaving a missing day looking like an empty one.
 *
 * One partition per day, sequentially, so widening the bound to 90 days triples
 * the worst-case round trips per tool call — and this result is awaited mid-turn
 * while the user watches. Kept sequential deliberately, not by omission:
 * `voc-context.ts::sumMetricWindow` escapes per-day reads because METRIC rows
 * live in one partition with a sortable date key, so BETWEEN bounds the window
 * server-side. Feedback rows do not — `gsi1pk` IS the date — so a window is N
 * partitions and no query shape collapses them. Bounded concurrency would cut
 * the wall time, but the obvious version breaks two properties this file relies
 * on: each in-flight day may spend the whole remaining candidate budget, so K
 * concurrent days hold up to K×MAX_CANDIDATES rows (the cap exists to bound
 * exactly that), and dividing the budget per day makes a moderate day report
 * `dayPartiallyRead` when the total is nowhere near the cap — a false truncation
 * signal in the one mechanism this file exists to make trustworthy. That is a
 * budgeting decision to take on its own, with a measurement; empty partitions
 * are cheap, so the cost lands on tenants with data across the whole window.
 */
async function fetchCandidatesByDate(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  days: number,
): Promise<{ candidates: FeedbackItem[]; reasons: TruncationReason[] }> {
  const now = new Date();
  const candidates: FeedbackItem[] = [];
  // Reasons accumulate into an array rather than a reassigned flag because this
  // package bans `let` (eslint no-restricted-syntax).
  const reasons: TruncationReason[] = [];

  for (const i of Array.from({ length: days }, (_, idx) => idx)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const day = await fetchDayPages(docClient, feedbackTable, dateStr, candidates);
      if (day.truncated) reasons.push('dayPartiallyRead');
      if (day.dropped > 0) reasons.push(...noteDroppedRows(dateStr, day.dropped));
    } catch (error) {
      reasons.push(...noteFailedDay(dateStr, error));
    }
    if (candidates.length >= MAX_CANDIDATES) {
      // Days still unread => the window was never fully scanned. `days` is the
      // whole window here, clamped or not, so this cannot claim "nothing left
      // unread" about days the caller asked for and the loop never reached.
      if (i < days - 1) reasons.push('daysUnread');
      break;
    }
  }
  return { candidates, reasons };
}

/**
 * A day that could not be read is a hole in the answer, not an empty day.
 *
 * The read is survived rather than propagated — one throttled partition should
 * not lose the other 89 — but survival without a report is how a sample comes
 * back claiming to be complete. The operator channel carries the cause (the
 * error name and the date); the model-facing notice does not, for the reason
 * voc-context.ts gives: an exception name is infrastructure detail that is not
 * actionable for whoever reads the answer.
 */
function noteFailedDay(dateStr: string, error: unknown): TruncationReason[] {
  const name = error instanceof Error ? error.name : 'UnknownError';
  console.warn(`search_feedback: DATE#${dateStr} could not be read (${name}); day skipped`);
  return ['dayReadFailed'];
}

/**
 * Rows safeParse rejected are candidates the answer does not contain.
 *
 * The schema is nearly all-optional with `.passthrough()`, so a rejection here
 * is genuinely unexpected and worth both signals: the date and count for an
 * operator, and the truncation reason so the answer is not presented as the
 * whole window.
 */
function noteDroppedRows(dateStr: string, dropped: number): TruncationReason[] {
  console.warn(`search_feedback: dropped ${dropped} unparseable rows from DATE#${dateStr}`);
  return ['rowsDropped'];
}

// ── Main export ──

/**
 * Resolve the effective search parameters from tool input + chat context.
 *
 * `days` is the EFFECTIVE window: clamped to MAX_LOOKBACK_DAYS here, once, so
 * the day loop, the cutoff filter and the notice text all spend one number.
 * Clamping inside the loop instead is the bug `metrics_handler.py` records
 * having had — the filter admitted a year of items while the scan collected a
 * month of them, and nothing said so.
 *
 * `requestedDays` is kept because the clamp is itself an unread remainder: a
 * caller asking for 365 gets 90, which the answer has to admit rather than
 * present as the year that was asked about. `chatRequestSchema` accepts up to
 * 365 (src/schema.ts), so this is reachable even though the SPA caps at 90.
 */
function resolveSearchParams(toolInput: unknown, contextFilters: ContextFilters): {
  input: SearchInput;
  query: string;
  mode: 'list' | 'aggregate';
  limit: number;
  days: number;
  requestedDays: number;
  filters: { source?: string; category?: string; sentiment?: string; urgency?: string };
} {
  const parsed = searchInputSchema.safeParse(toolInput);
  const input: SearchInput = parsed.success ? parsed.data : {};
  const requestedDays = contextFilters.days ?? 30;
  return {
    input,
    query: input.query ?? '',
    mode: input.mode ?? 'list',
    // aggregate mode returns stats over the whole match set, so a small list
    // cap there is fine (only used for the handful of examples we show).
    limit: Math.min(input.limit ?? 15, 30),
    days: Math.min(requestedDays, MAX_LOOKBACK_DAYS),
    requestedDays,
    filters: {
      source: input.source ?? contextFilters.source,
      category: input.category ?? contextFilters.category,
      sentiment: input.sentiment ?? contextFilters.sentiment,
      urgency: input.urgency,
    },
  };
}

export async function executeSearchFeedback(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  toolInput: unknown,
  contextFilters: ContextFilters,
): Promise<SearchFeedbackResult> {
  const {
    input, query, mode, limit, days, requestedDays, filters,
  } = resolveSearchParams(toolInput, contextFilters);

  if (!feedbackTable) throw new ConfigurationError('Feedback table not configured');

  // Check if query is a feedback ID
  if (query && /^[a-f0-9]{32}$/i.test(query.trim())) {
    const idResult = await lookupByFeedbackId(docClient, feedbackTable, query);
    if (idResult) return idResult;
  }

  const scan = await fetchCandidatesByDate(docClient, feedbackTable, days);
  // The clamp is a truncation like any other: the caller asked about a longer
  // window than this scan can reach, so the answer covers less than the
  // question did and has to say which window it actually read.
  const reasons = requestedDays > days ? ['windowClamped' as const, ...scan.reasons] : scan.reasons;
  const isPartial = reasons.length > 0;

  // Days-long window ending today (same definition as the metrics API).
  // `days` is the clamped window, the same one the scan read, so the filter
  // cannot admit items from days that were never queried.
  // Review basis compares against the date the customer wrote the item; the
  // import-date scan above always contains those items, since a review can't
  // be imported before it was written (issue #150).
  const dateBasis = contextFilters.dateBasis;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const allMatched = scan.candidates.filter((item) =>
    matchesFeedbackItem(item, query, filters, cutoffDate, dateBasis),
  );

  const notice = truncationNotice(reasons, days, requestedDays);

  // aggregate mode: summarize the WHOLE match set in one call (no list cap),
  // so "summarize all feedback" / "top issues" don't force the model to loop.
  if (mode === 'aggregate') {
    const examples = [...allMatched].sort(compareByUrgency).slice(0, limit);
    return {
      items: examples,
      formatted: formatAggregate(allMatched, examples, isPartial) + notice,
      isPartial,
    };
  }

  if (input.sort_by === 'urgency') {
    allMatched.sort(compareByUrgency);
  }
  const matched = allMatched.slice(0, limit);

  return { items: matched, formatted: formatToolResults(matched) + notice, isPartial };
}

// ── Formatting ──

/** One clause per cause, so the notice explains the truncation it actually had. */
const TRUNCATION_CLAUSES: Record<TruncationReason, string> = {
  windowClamped: 'the requested window is longer than this search can reach',
  dayPartiallyRead: `a day held more feedback than the candidate budget allowed (cap ${MAX_CANDIDATES})`,
  daysUnread: 'the candidate budget ran out with older days still unread',
  dayReadFailed: 'at least one day could not be read',
  rowsDropped: 'some stored rows could not be parsed and were skipped',
};

/**
 * The paragraph the model reads when the answer covers less than the question.
 *
 * Empty when the window was fully read, so a complete answer carries no
 * hedging. This is the ONE place the truncation is stated in prose, in both
 * modes: `formatAggregate` drops its completeness claim and annotates the total
 * but does not repeat the instruction, because three statements of one fact in
 * the highest-attention region of the tool result dilute rather than reinforce,
 * and leave two wordings to keep in sync.
 *
 * Phrased as an instruction because the consumer is the model: left as a bare
 * boolean on the returned object it would never reach the user, who has no
 * other way to tell a capped answer from a complete one.
 *
 * Names the window actually SCANNED, not the one requested — the earlier
 * wording said "the 365-day window" about a scan that read 90 days of it, so
 * the model hedged about a window nothing had looked at.
 *
 * English is deliberate, matching voc-context.ts's degradedNote: this is prompt
 * text rather than UI copy, and buildSystemPrompt instructs the model to answer
 * in `response_language`, so the model relays the fact in the user's language.
 * Translating it would change nothing the user reads.
 */
function truncationNotice(
  reasons: TruncationReason[],
  scannedDays: number,
  requestedDays: number,
): string {
  if (reasons.length === 0) return '';
  const causes = [...new Set(reasons)].map((reason) => TRUNCATION_CLAUSES[reason]).join('; ');
  const windowRead = requestedDays > scannedDays
    ? `only the most recent ${scannedDays} days of the ${requestedDays}-day window asked about`
    : `part of the ${scannedDays}-day window`;
  return `\n⚠️ INCOMPLETE RESULTS: the items and any counts above cover ${windowRead} `
    + `— ${causes}. Say so when you answer, name the ${scannedDays}-day window they do cover, `
    + 'and do not present these totals or percentages as complete.\n';
}

function formatSingleItem(item: FeedbackItem, index: number): string {
  const sourceDate = item.source_created_at?.slice(0, 10) ?? 'N/A';
  const problemLine = item.problem_summary ? `- Problem Summary: ${item.problem_summary}` : '';
  const score = Number(item.sentiment_score ?? 0).toFixed(2);
  return `### Feedback #${index + 1}
- Source: ${item.source_platform ?? 'unknown'}
- Date: ${sourceDate}
- Sentiment: ${item.sentiment_label ?? 'unknown'} (${score})
- Category: ${item.category ?? 'other'}
- Rating: ${item.rating ?? 'N/A'}
- Text: "${(item.original_text ?? '').slice(0, 400)}"
${problemLine}

`;
}

function formatToolResults(items: FeedbackItem[]): string {
  if (items.length === 0) return 'No feedback found matching the search criteria.';
  const header = `Found ${items.length} relevant feedback items:\n\n`;
  return header + items.map((item, i) => formatSingleItem(item, i)).join('');
}

// ── Aggregate formatting ──

function countBy(items: FeedbackItem[], field: keyof FeedbackItem): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = String(item[field] ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatDistribution(label: string, dist: [string, number][], total: number): string {
  if (dist.length === 0) return '';
  const lines = dist
    .map(([k, n]) => `- ${k}: ${n} (${((n / Math.max(total, 1)) * 100).toFixed(0)}%)`)
    .join('\n');
  return `**${label}:**\n${lines}\n\n`;
}

// One-call summary over the ENTIRE match set: total, distributions by urgency /
// sentiment / category / source, average rating, plus the top examples (already
// urgency-sorted) so the model can quote specifics without another search.
//
// When the scan was truncated (`isPartial`) the "COMPLETE set" claim below is
// false, and it is the most dangerous sentence in this file: the model is told
// in so many words to base its answer on numbers that only cover the most recent
// slice of the window. So the header states which it is, and the total carries
// the annotation — but NOT the instruction to relay it, which `truncationNotice`
// owns for both modes. One imperative, in one place, with the causes named.
//
// `isPartial` has no default: a fail-closed signature, so a future call site
// cannot silently inherit the "COMPLETE set" wording by forgetting the argument.
function formatAggregate(all: FeedbackItem[], examples: FeedbackItem[], isPartial: boolean): string {
  const total = all.length;
  if (total === 0) return 'No feedback found matching the search criteria.';

  const ratings = all.map((i) => i.rating).filter((r): r is number => typeof r === 'number');
  const avgRating = ratings.length > 0
    ? (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(2)
    : 'N/A';

  const sections = [
    isPartial
      ? `Aggregate summary over ${total} matching feedback items `
      : `Aggregate summary over ALL ${total} matching feedback items `,
    isPartial
      ? '(⚠️ PARTIAL — a sample of the window, NOT the complete set; see the note '
        + 'below these figures):\n\n'
      : '(this is the COMPLETE set, not a sample — base your answer on these numbers):\n\n',
    `**Total matches:** ${total}${isPartial ? ' (partial — scan truncated)' : ''}\n`,
    `**Average rating:** ${avgRating}\n\n`,
    formatDistribution('By urgency', countBy(all, 'urgency'), total),
    formatDistribution('By sentiment', countBy(all, 'sentiment_label'), total),
    formatDistribution('By category', countBy(all, 'category').slice(0, 10), total),
    formatDistribution('By source', countBy(all, 'source_platform'), total),
  ];

  if (examples.length > 0) {
    sections.push(
      `**Top ${examples.length} examples (most urgent first):**\n\n`,
      examples.map((item, i) => formatSingleItem(item, i)).join(''),
    );
  }
  return sections.join('');
}
