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
}).passthrough();

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
  sentiment_score: z.number().optional(),
  category: z.string().optional(),
  rating: z.number().nullable().optional(),
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
    try {
      const resp = await docClient.send(
        new QueryCommand({
          TableName: feedbackTable,
          IndexName: 'gsi1-by-date',
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': `DATE#${dateStr}` },
          Limit: 300,
          ScanIndexForward: false,
        }),
      );
      candidates.push(...(resp.Items ?? []).map((raw) => feedbackItemSchema.parse(raw)));
      if (candidates.length >= 1000) break;
    } catch {
      // continue
    }
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

  const matched = candidates
    .filter((item) => matchesFeedbackItem(item, query, filters, cutoffDate))
    .slice(0, limit);

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
