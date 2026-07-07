/**
 * search_feedback tool implementation.
 * Ported from Python chat_stream_handler.py.
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError } from '../lib/errors.js';

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

// ── Filtering ──

function passesDateFilter(item: FeedbackItem, cutoffDate: string): boolean {
  return (item.date ?? '') >= cutoffDate;
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
): boolean {
  return passesDateFilter(item, cutoffDate)
    && passesFieldFilters(item, filters)
    && passesTextSearch(item, query);
}

// ── Query helpers ──

async function lookupByFeedbackId(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  feedbackId: string,
): Promise<{ items: FeedbackItem[]; formatted: string } | null> {
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: feedbackTable,
        IndexName: 'gsi4-by-feedback-id',
        KeyConditionExpression: 'feedback_id = :fid',
        ExpressionAttributeValues: { ':fid': feedbackId.toLowerCase().trim() },
        Limit: 1,
      }),
    );
    const items = (resp.Items ?? []).map((raw) => feedbackItemSchema.parse(raw));
    if (items.length > 0) {
      return { items, formatted: formatToolResults(items) };
    }
  } catch {
    // Fall through to date-based search
  }
  return null;
}

// Upper bound on candidates collected across all days. A DynamoDB Query caps
// each page at 1MB (often far fewer than 1000 large items), so we MUST follow
// LastEvaluatedKey to page through a day — otherwise a day with thousands of
// rows is silently truncated to the first ~500 (this caused "987 negative but
// tool only saw 116"). Bound the total so aggregate mode can summarize the full
// set without unbounded memory/time on a huge table.
const MAX_CANDIDATES = 10000;

async function fetchCandidatesByDate(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  days: number,
): Promise<FeedbackItem[]> {
  const now = new Date();
  const candidates: FeedbackItem[] = [];

  for (const i of Array.from({ length: Math.min(days, 30) }, (_, idx) => idx)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    let lastKey: Record<string, unknown> | undefined;
    try {
      // Page through the whole day via LastEvaluatedKey, not just the first page.
      do {
        const resp = await docClient.send(
          new QueryCommand({
            TableName: feedbackTable,
            IndexName: 'gsi1-by-date',
            KeyConditionExpression: 'gsi1pk = :pk',
            ExpressionAttributeValues: { ':pk': `DATE#${dateStr}` },
            ScanIndexForward: false,
            ExclusiveStartKey: lastKey,
          }),
        );
        // Per-row safeParse: a single malformed item must not throw and discard
        // the whole day's results (the outer catch would skip the entire date).
        for (const raw of resp.Items ?? []) {
          const parsed = feedbackItemSchema.safeParse(raw);
          if (parsed.success) candidates.push(parsed.data);
        }
        lastKey = resp.LastEvaluatedKey;
      } while (lastKey && candidates.length < MAX_CANDIDATES);
    } catch {
      // continue to the next day
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

// ── Main export ──

export async function executeSearchFeedback(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  toolInput: unknown,
  contextFilters: ContextFilters,
): Promise<{ items: FeedbackItem[]; formatted: string }> {
  const parsed = searchInputSchema.safeParse(toolInput);
  const input: SearchInput = parsed.success ? parsed.data : {};
  const query = input.query ?? '';
  const mode = input.mode ?? 'list';
  // aggregate mode returns stats over the whole match set, so a small list cap
  // there is fine (only used for the handful of examples we show).
  const limit = Math.min(input.limit ?? 15, 30);
  const days = contextFilters.days ?? 30;

  const filters = {
    source: input.source ?? contextFilters.source,
    category: input.category ?? contextFilters.category,
    sentiment: input.sentiment ?? contextFilters.sentiment,
    urgency: input.urgency,
  };

  if (!feedbackTable) throw new ConfigurationError('Feedback table not configured');

  // Check if query is a feedback ID
  if (query && /^[a-f0-9]{32}$/i.test(query.trim())) {
    const idResult = await lookupByFeedbackId(docClient, feedbackTable, query);
    if (idResult) return idResult;
  }

  const candidates = await fetchCandidatesByDate(docClient, feedbackTable, days);

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const allMatched = candidates.filter((item) =>
    matchesFeedbackItem(item, query, filters, cutoffDate),
  );

  // aggregate mode: summarize the WHOLE match set in one call (no list cap),
  // so "summarize all feedback" / "top issues" don't force the model to loop.
  if (mode === 'aggregate') {
    const examples = [...allMatched].sort(compareByUrgency).slice(0, limit);
    return { items: examples, formatted: formatAggregate(allMatched, examples) };
  }

  if (input.sort_by === 'urgency') {
    allMatched.sort(compareByUrgency);
  }
  const matched = allMatched.slice(0, limit);

  return { items: matched, formatted: formatToolResults(matched) };
}

// ── Formatting ──

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
function formatAggregate(all: FeedbackItem[], examples: FeedbackItem[]): string {
  const total = all.length;
  if (total === 0) return 'No feedback found matching the search criteria.';

  const ratings = all.map((i) => i.rating).filter((r): r is number => typeof r === 'number');
  const avgRating = ratings.length > 0
    ? (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(2)
    : 'N/A';

  let out = `Aggregate summary over ALL ${total} matching feedback items `;
  out += `(this is the COMPLETE set, not a sample — base your answer on these numbers):\n\n`;
  out += `**Total matches:** ${total}\n`;
  out += `**Average rating:** ${avgRating}\n\n`;
  out += formatDistribution('By urgency', countBy(all, 'urgency'), total);
  out += formatDistribution('By sentiment', countBy(all, 'sentiment_label'), total);
  out += formatDistribution('By category', countBy(all, 'category').slice(0, 10), total);
  out += formatDistribution('By source', countBy(all, 'source_platform'), total);

  if (examples.length > 0) {
    out += `**Top ${examples.length} examples (most urgent first):**\n\n`;
    out += examples.map((item, i) => formatSingleItem(item, i)).join('');
  }
  return out;
}
