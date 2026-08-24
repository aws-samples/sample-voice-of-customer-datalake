/**
 * search_feedback tool implementation.
 * Ported from Python chat_stream_handler.py.
 *
 * Filtering, formatting and the prose the model reads. The reads themselves —
 * and every shortfall they have to admit — live in ./feedback-scan.ts.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError } from '../lib/errors.js';
import {
  fetchCandidatesByDate,
  feedbackItemSchema,
  queryFeedbackById,
  DAY_SCAN_CONCURRENCY,
  MAX_CANDIDATES,
  MAX_LOOKBACK_DAYS,
  type FeedbackItem,
  type TruncationReason,
} from './feedback-scan.js';

// Re-exported so the constants keep one import path for callers and tests. They
// are declared in feedback-scan.ts, which the lockstep guard parses.
export { DAY_SCAN_CONCURRENCY, MAX_CANDIDATES, MAX_LOOKBACK_DAYS };

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

/**
 * One row by key, or null when the caller should fall through to the date scan.
 *
 * Three outcomes, deliberately distinguished. A parsed row is the answer. No
 * row, or a failed query, falls through. A row that EXISTS but does not parse
 * used to fall through too — strict `.parse` threw into the catch — which turned
 * a single-key lookup into a 90-day, 91-query scan whose truncation notice then
 * described the window rather than the item the user asked about, while the scan
 * re-read the same malformed row and returned nothing. So that case is answered
 * here, about the item, in one query.
 */
async function lookupByFeedbackId(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  feedbackId: string,
): Promise<SearchFeedbackResult | null> {
  const rows = await queryFeedbackById(docClient, feedbackTable, feedbackId);
  if (rows === null || rows.length === 0) return null;
  const items = rows.flatMap((raw) => {
    const parsed = feedbackItemSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  // A direct ID hit reads one row by key: nothing was truncated.
  if (items.length > 0) return { items, formatted: formatToolResults(items), isPartial: false };
  console.warn(`search_feedback: feedback_id ${feedbackId} matched a row that would not parse`);
  return {
    items: [],
    formatted: 'The requested feedback item exists but its stored row could not be read, so '
      + 'its details are unavailable. Say that the item could not be read — do NOT say no such '
      + 'item exists, and do not present other feedback as if it were this item.\n',
    isPartial: true,
  };
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
  // Overridable so the cap-reached cases can be driven with a handful of rows
  // instead of materialising MAX_CANDIDATES zod-parsed fixtures per test.
  candidateCap: number = MAX_CANDIDATES,
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

  const scan = await fetchCandidatesByDate(docClient, feedbackTable, days, candidateCap);
  // Not one partition answered, so this window is unknown rather than empty and
  // must not be formatted as a search that found nothing.
  if (scan.unmeasured) {
    return { items: [], formatted: unmeasuredWindowNotice(days), isPartial: true };
  }
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

/**
 * What the model is told when NO day of the window could be read.
 *
 * Not "no feedback found matching the search criteria": nothing was measured, so
 * zero is not a finding. query-errors.ts states the requirement for any consumer
 * of a failed fan-out — "treat the numbers it leaves behind as unmeasured rather
 * than as zero" — and a user asking how much negative feedback arrived must not
 * be told there was none when the tool could not look. The cause stays in the
 * operator log, where the error name is actionable.
 */
function unmeasuredWindowNotice(scannedDays: number): string {
  return `⚠️ THE SEARCH COULD NOT BE RUN: no day of the ${scannedDays}-day window could be read, `
    + 'so nothing is known about it. This is NOT a result of zero feedback items. Tell the user '
    + 'the feedback store could not be reached and that you therefore cannot answer, and do not '
    + 'state or imply any count — including zero.\n';
}

/** One clause per cause, so the notice explains the truncation it actually had. */
const TRUNCATION_CLAUSES: Record<TruncationReason, string> = {
  windowClamped: 'the requested window is longer than this search can reach',
  dayPartiallyRead: `a day held more feedback than the candidate budget allowed (cap ${MAX_CANDIDATES})`,
  daysUnread: 'the scan stopped early, leaving older days still unread',
  dayReadFailed: 'at least one day could not be read',
  rowsDropped: 'a large share of the stored rows could not be parsed and were skipped',
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
