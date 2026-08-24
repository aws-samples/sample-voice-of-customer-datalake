/**
 * Reading feedback rows for the search_feedback tool, and saying what the read
 * missed.
 *
 * Split from search-feedback.ts, which now owns filtering, formatting and the
 * prose the model reads. The seam is the one the truncation work exposed: every
 * function here answers "what could this read reach?", and every shortfall it
 * returns is something the answer has to admit. Keeping them together means a
 * new stopping point is added beside the ones that already report themselves,
 * rather than beside the formatters where the reporting is easy to forget —
 * which is how three silent stopping points accumulated in the first place.
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX } from '../indexes.js';
import { PERSISTENT_QUERY_ERRORS } from '../context/query-errors.js';

export const feedbackItemSchema = z.object({
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

export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

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
 * rule with two copies.
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
 * Spent in exactly one place — `resolveSearchParams` in search-feedback.ts — so
 * the scan bound, the cutoff filter and the notice text cannot disagree about
 * which window an answer covers. `metrics_handler.py` carries the same warning
 * from having had that bug: "This read `min(days, 30)` while `cutoff_date` above
 * was computed from the caller's full `days`, so the two disagreed."
 *
 * Keep the literal on one line as `export const MAX_LOOKBACK_DAYS = <n>` — the
 * lockstep test parses this text.
 */
export const MAX_LOOKBACK_DAYS = 90;

/**
 * How many day partitions are read at once. See `scanWaves`.
 *
 * Exported so the test can assert the fan-out is really bounded at this width,
 * rather than having quietly returned to one round trip at a time.
 */
export const DAY_SCAN_CONCURRENCY = 8;

/**
 * Why an answer covers less than the window the caller asked about.
 *
 * Each cause gets its own clause in the model-facing notice, because a notice
 * that names one cause for all of them misattributes the rest: "the candidate
 * cap" is a wrong explanation for a throttled partition or a clamped window.
 */
export type TruncationReason =
  | 'windowClamped'
  | 'dayPartiallyRead'
  | 'daysUnread'
  | 'dayReadFailed'
  | 'rowsDropped';

/**
 * Did the scan fail to read the window it actually scanned?
 *
 * `windowClamped` is excluded deliberately, and this predicate exists to make the
 * exclusion explicit rather than incidental. That reason fires on the REQUEST,
 * independently of the data: for any caller asking beyond MAX_LOOKBACK_DAYS every
 * answer carries it, including one over a fully-read window where nothing was
 * truncated at all. Treating it as truncation made aggregate mode call such
 * figures "a sample … NOT the complete set" and annotate the total "scan
 * truncated" when every partition had been read to its end — inaccuracy in the
 * opposite direction from the one this file exists to fix, and the reason a
 * future "partial results" badge would be wrong on a complete 90-day answer.
 *
 * The narrowing still has to be stated, and is: `truncationNotice` renders a
 * distinct paragraph naming the window read and the days it says nothing about.
 * So `isPartial` continues to mean "covers less than the question asked", while
 * this narrower predicate means "did not read what it scanned".
 */
export function scanWasIncomplete(reasons: TruncationReason[]): boolean {
  return reasons.some((reason) => reason !== 'windowClamped');
}

/**
 * The share of rows a scan may lose to safeParse before the answer counts as a
 * sample rather than the window.
 *
 * A single permanently-malformed legacy row would otherwise make EVERY answer
 * partial forever: the row fails identically on every future call, so the hedge
 * becomes background noise and a real truncation — the cap, a throttle — reads
 * the same as 99.9% of the corpus arriving intact. A flag that always fires
 * carries no information, the same reasoning voc-context.ts gives for
 * aggregating its warnings ("sixteen warnings say nothing the first one did").
 * Bulk loss is different in kind: a producer change or a migration that breaks a
 * tenth of the rows really does bend the distributions, so that is where the
 * line sits. Below it the drop is still logged — an operator can find and repair
 * the row — it just does not tell the model the window was truncated.
 *
 * recent-feedback.ts drops such rows silently and voc-context.ts counts them
 * into its degraded flag; the difference is what the row IS. There a dropped row
 * is a counter whose value was the measurement, so losing it provably
 * understates a total. Here it is one item among thousands in a distribution.
 */
const DROPPED_ROWS_PARTIAL_SHARE = 0.1;

/**
 * The candidate ceiling, shared by every day in the scan.
 *
 * ONE counter, deliberately, not a per-day slice of the remainder. Slicing is
 * what makes concurrency unsafe here: it would let K in-flight days each believe
 * they may spend the whole budget (K×MAX_CANDIDATES rows held at once, which is
 * the thing the cap exists to bound), and dividing it K ways instead makes a
 * moderate day report `dayPartiallyRead` while the total is nowhere near the cap
 * — a false truncation signal in the one mechanism this file exists to make
 * trustworthy. A shared counter has neither problem: every page charges the same
 * budget as it lands, so the cap means what it says and a day reports truncation
 * only when the budget is genuinely gone.
 *
 * Mutated in place because this package bans `let` (eslint no-restricted-syntax).
 */
interface CandidateBudget {
  cap: number;
  spent: number;
}

function budgetExhausted(budget: CandidateBudget): boolean {
  return budget.spent >= budget.cap;
}

/** What one day's read cost the answer: pages left unread, rows dropped. */
interface DayReadOutcome {
  truncated: boolean;
  dropped: number;
  errorName?: string;
}

/** One day's rows and what its read cost, kept together for the wave to fold. */
interface DayRead extends DayReadOutcome {
  dateStr: string;
  items: FeedbackItem[];
}

/** Days that dropped rows or failed outright, for one aggregated report. */
interface ScanShortfalls {
  failures: { dateStr: string; errorName: string }[];
  drops: { dateStr: string; dropped: number }[];
  /** Dates read without error — empty means the window was never measured. */
  daysRead: string[];
}

/** What a date scan collected, and every way it fell short of its window. */
export interface DateScanResult {
  candidates: FeedbackItem[];
  reasons: TruncationReason[];
  /** True when NOT ONE day answered: the window is unknown, not empty. */
  unmeasured: boolean;
}

/** The ID index's rows, or null when the query itself failed. */
export async function queryFeedbackById(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  feedbackId: string,
): Promise<Record<string, unknown>[] | null> {
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
    return resp.Items ?? [];
  } catch {
    // A failed lookup falls through to the date scan, which reads a different
    // index and may still find the item.
    return null;
  }
}

/**
 * One page of one day's partition. A failed read is RETURNED, not thrown.
 *
 * Same shape as voc-context.ts::readMetricPage, for the same reason: throwing
 * discarded the pages already read, turning a partial day into a confident
 * absence. The name travels with it because the caller needs it twice — to log
 * one line per distinct cause, and to tell a systemic failure (which repeats
 * identically for every partition) from one partition's bad luck.
 */
async function readDayPage(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  dateStr: string,
  startKey?: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  lastKey?: Record<string, unknown>;
  errorName?: string;
}> {
  try {
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
    return { items: resp.Items ?? [], lastKey: resp.LastEvaluatedKey };
  } catch (error) {
    return { items: [], errorName: error instanceof Error ? error.name : 'UnknownError' };
  }
}

/**
 * Page through one day's GSI partition via LastEvaluatedKey (not just the
 * first page), appending valid rows to `candidates`. Per-row safeParse: a
 * single malformed item must not throw and discard the whole day's results.
 * Recursion depth = pages in the day's partition; the budget check stops early
 * only as parsed rows accumulate (a day of entirely malformed rows still pages
 * to its end, same as the previous do/while).
 *
 * `truncated` is true when the day still had pages left but the shared candidate
 * budget stopped the walk. `dropped` counts rows safeParse rejected. `errorName`
 * names a read that failed: the rows already collected survive it — a partition
 * whose second page fails must keep what its first page measured, the rule
 * voc-context.ts::readMetricPage states — and the caller reports the hole.
 *
 * Rows land in this day's OWN array rather than straight into the shared list,
 * so concurrently-read days cannot interleave: the caller concatenates them in
 * date order. The budget is charged as pages land, so the cap still bounds the
 * whole scan rather than each day separately.
 */
async function fetchDayPages(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  dateStr: string,
  candidates: FeedbackItem[],
  budget: CandidateBudget,
  startKey?: Record<string, unknown>,
): Promise<DayReadOutcome> {
  const page = await readDayPage(docClient, feedbackTable, dateStr, startKey);
  const parsedRows = page.items.map((raw) => feedbackItemSchema.safeParse(raw));
  for (const parsed of parsedRows) {
    if (parsed.success) candidates.push(parsed.data);
  }
  const dropped = parsedRows.filter((parsed) => !parsed.success).length;
  budget.spent += parsedRows.length - dropped;
  if (page.errorName !== undefined) return { truncated: false, dropped, errorName: page.errorName };
  if (!page.lastKey) return { truncated: false, dropped };
  if (budgetExhausted(budget)) return { truncated: true, dropped };
  const rest = await fetchDayPages(
    docClient, feedbackTable, dateStr, candidates, budget, page.lastKey,
  );
  return { ...rest, dropped: dropped + rest.dropped };
}

/** One day's rows and outcome. Never throws: a failed read is a reported hole. */
async function readOneDay(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  dateStr: string,
  budget: CandidateBudget,
): Promise<DayRead> {
  const items: FeedbackItem[] = [];
  const outcome = await fetchDayPages(docClient, feedbackTable, dateStr, items, budget);
  return { ...outcome, dateStr, items };
}

/** True when a wave hit a fault that will repeat identically for every day left. */
function hasSystemicFailure(reads: DayRead[]): boolean {
  // Retrying the remaining partitions just repeats the failure, and reporting it
  // N times says nothing the first line did — both consequences query-errors.ts
  // states, and recent-feedback.ts already applies to its own fan-out over these
  // same DATE# partitions.
  return reads.some(
    (read) => read.errorName !== undefined && PERSISTENT_QUERY_ERRORS.has(read.errorName),
  );
}

/**
 * Read the waves in order, stopping once the budget is gone or a fault is systemic.
 *
 * Recursion rather than a loop because the accumulator has to stay `const`.
 * Ordering is by DATE, not completion: each wave's days are concatenated in the
 * order they were dispatched, so list mode's default 'recent' sort — which is
 * the scan order itself — is unchanged from the sequential version.
 *
 * Shortfalls are collected, not logged here. A systemic cause makes every day of
 * the window say the same thing, so 90 identical CloudWatch lines per chat turn
 * would say nothing the first one did; `reportShortfalls` runs once for the whole
 * scan, the same aggregation point and the same reason as
 * voc-context.ts::reportMetricFailures.
 */
async function scanWaves(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  waves: string[][],
  budget: CandidateBudget,
  acc: { candidates: FeedbackItem[]; reasons: TruncationReason[]; shortfalls: ScanShortfalls },
  index = 0,
): Promise<{ candidates: FeedbackItem[]; reasons: TruncationReason[]; shortfalls: ScanShortfalls }> {
  if (index >= waves.length) return acc;
  const reads = await Promise.all(
    waves[index].map((dateStr) => readOneDay(docClient, feedbackTable, dateStr, budget)),
  );
  const next = {
    candidates: [...acc.candidates, ...reads.flatMap((read) => read.items)],
    reasons: [
      ...acc.reasons,
      ...reads.flatMap((read) => (read.truncated ? (['dayPartiallyRead'] as const) : [])),
    ],
    shortfalls: {
      failures: [
        ...acc.shortfalls.failures,
        ...reads.flatMap((read) => (read.errorName === undefined
          ? []
          : [{ dateStr: read.dateStr, errorName: read.errorName }])),
      ],
      drops: [
        ...acc.shortfalls.drops,
        ...reads.flatMap((read) => (read.dropped > 0
          ? [{ dateStr: read.dateStr, dropped: read.dropped }]
          : [])),
      ],
      daysRead: [
        ...acc.shortfalls.daysRead,
        ...reads.flatMap((read) => (read.errorName === undefined ? [read.dateStr] : [])),
      ],
    },
  };
  if (budgetExhausted(budget) || hasSystemicFailure(reads)) {
    // Waves after this one were never dispatched, so those days are genuinely
    // unread. Every day WITHIN this wave was read, hence the wave-level test:
    // claiming 'daysUnread' for them would be a truncation that did not happen.
    return index + 1 < waves.length
      ? { ...next, reasons: [...next.reasons, 'daysUnread'] }
      : next;
  }
  return scanWaves(docClient, feedbackTable, waves, budget, next, index + 1);
}

/**
 * Collect candidates day by day, newest first, over exactly `days` partitions.
 *
 * `days` must already be clamped to MAX_LOOKBACK_DAYS — `resolveSearchParams`
 * is the single place that does it, so the scan bound is the same number the
 * cutoff filter uses. Clamping again here is what made the two disagree before.
 *
 * Returns every way this scan fell short of the window it was asked for, so the
 * caller can say which, plus `unmeasured` for the case where NO day was read:
 * that window is unknown rather than empty, and must not be answered with "no
 * feedback found". Mirrors the Python route's `_scan_recent_items` in
 * lambda/api/metrics_handler.py, which returns `(items, is_partial)` for the
 * same reason — with the additions this runtime needs because it has failure
 * modes Python's does not: `_query_partition` propagates a failed read while
 * this scan survives it, so a survived failure must be REPORTED (the rule
 * voc-context.ts states for its metric pages) rather than leaving a missing day
 * looking like an empty one.
 *
 * Days are read DAY_SCAN_CONCURRENCY at a time, newest wave first. Sequentially
 * a 90-day window is 90 round trips awaited mid-turn while the user watches a
 * half-rendered answer; at a 12ms round trip that measured p99 1092ms against
 * 153ms in waves of 8 — less even than the 30-day sequential scan this widening
 * replaced (364ms), so the window got three times wider and still got faster.
 *
 * A range query is not available: `voc-context.ts::sumMetricWindow` escapes
 * per-day reads because METRIC rows share one partition with a sortable date
 * key, so BETWEEN bounds the window server-side. Feedback rows do not — `gsi1pk`
 * IS the date — so a window is N partitions and no query shape collapses them.
 * Concurrency is what is left, and it is safe here only because the candidate
 * budget is one shared counter rather than a per-day slice; see CandidateBudget
 * for why the sliced version would both hold K× the rows and invent truncation
 * signals that never happened. `context/recent-feedback.ts` fans out over these
 * very partitions for the same reason, in waves of 7.
 */
export async function fetchCandidatesByDate(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  days: number,
  candidateCap: number,
): Promise<DateScanResult> {
  const now = new Date();
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().slice(0, 10);
  });
  const waves = Array.from(
    { length: Math.ceil(dates.length / DAY_SCAN_CONCURRENCY) },
    (_, i) => dates.slice(i * DAY_SCAN_CONCURRENCY, (i + 1) * DAY_SCAN_CONCURRENCY),
  );
  const scan = await scanWaves(docClient, feedbackTable, waves, { cap: candidateCap, spent: 0 }, {
    candidates: [],
    reasons: [],
    shortfalls: { failures: [], drops: [], daysRead: [] },
  });
  return {
    candidates: scan.candidates,
    reasons: [...scan.reasons, ...reportShortfalls(scan.shortfalls, scan.candidates.length)],
    unmeasured: scan.shortfalls.daysRead.length === 0,
  };
}

/**
 * Log every shortfall once, and answer which of them make the answer a sample.
 *
 * Two channels with different jobs, as voc-context.ts::reportMetricFailures
 * splits them. The operator log carries the causes and the dates: an error name
 * like ProvisionedThroughputExceededException tells someone the read is being
 * throttled, and the dates say which partitions to look at. The returned reasons
 * carry only what changes the ANSWER, because an exception name is
 * infrastructure detail that is not actionable for whoever reads it.
 *
 * A failed day is always a reason: a hole in the window makes the counts a
 * sample. Dropped rows are a reason only in bulk — see
 * DROPPED_ROWS_PARTIAL_SHARE — because one permanently-broken legacy row would
 * otherwise hedge every answer forever, over a window that was fully read.
 */
function reportShortfalls(shortfalls: ScanShortfalls, collected: number): TruncationReason[] {
  const byName = new Map<string, string[]>();
  for (const failure of shortfalls.failures) {
    byName.set(failure.errorName, [...(byName.get(failure.errorName) ?? []), failure.dateStr]);
  }
  for (const [errorName, dates] of byName) {
    const systemic = PERSISTENT_QUERY_ERRORS.has(errorName)
      ? ' — this name fails identically for every partition of the index, so the scan stopped'
      : '';
    console.warn(
      `search_feedback: ${dates.length} day partition(s) failed with ${errorName}${systemic}; those days are missing from the answer. Unread: ${dates.join('; ')}`,
    );
  }

  const dropped = shortfalls.drops.reduce((sum, drop) => sum + drop.dropped, 0);
  if (dropped > 0) {
    console.warn(
      `search_feedback: dropped ${dropped} unparseable row(s) across ${shortfalls.drops.length} day(s); repair the rows to make them searchable. Dates: ${shortfalls.drops.map((drop) => drop.dateStr).join('; ')}`,
    );
  }

  const bulkLoss = dropped > (collected + dropped) * DROPPED_ROWS_PARTIAL_SHARE;
  return [
    ...(shortfalls.failures.length > 0 ? (['dayReadFailed'] as const) : []),
    ...(bulkLoss ? (['rowsDropped'] as const) : []),
  ];
}
