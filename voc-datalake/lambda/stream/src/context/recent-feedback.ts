/**
 * Recent-feedback prompt section for project chat / roundtable context.
 *
 * The processor writes per-day partitions (gsi1pk = 'DATE#YYYY-MM-DD'), so
 * "most recent" means walking backward day by day until enough items are
 * collected — the same pattern as tools/search-feedback.ts. A bare 'DATE'
 * equality query matches nothing (issue #220), which silently emptied this
 * prompt section.
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { FEEDBACK_BY_DATE_INDEX } from '../indexes.js';

export interface FeedbackSummary {
  count: number;
  promptSection: string;
}

const feedbackItemSchema = z.object({
  source_platform: z.string().optional(),
  sentiment_label: z.string().optional(),
  category: z.string().optional(),
  original_text: z.string().optional(),
}).passthrough();

type RecentFeedbackItem = z.infer<typeof feedbackItemSchema>;

// How many items the prompt section collects, and how far back to look.
const RECENT_FEEDBACK_TARGET = 30;
const RECENT_FEEDBACK_LOOKBACK_DAYS = 30;
const RECENT_FEEDBACK_PROMPT_LINES = 15;

// This runs on every project chat/roundtable request (not just explicit tool
// calls), so day queries are issued in parallel batches: a sparse or empty
// table costs at most LOOKBACK/BATCH sequential rounds (~5), not 30 serial
// round-trips, and the common case (today has data) stays a single round.
const DAY_QUERY_BATCH_SIZE = 7;

// Error names that will fail identically for every partition of the same
// index — retrying the remaining days would just repeat the failure 30x
// and silently reproduce the empty-section symptom this fix removes.
const PERSISTENT_QUERY_ERRORS = new Set([
  'AccessDeniedException',
  'ResourceNotFoundException',
  'ValidationException',
]);

/** Parse and append one page of rows, capped at the collection target.
 * Per-row safeParse: one malformed item must not discard the rest. Note this
 * is best-effort: a day whose first `Limit` rows include malformed items can
 * under-fill the target even if more valid rows exist in that partition (we
 * don't follow LastEvaluatedKey here — acceptable for a prompt section). */
function collectFeedbackRows(
  rawItems: Record<string, unknown>[] | undefined,
  items: RecentFeedbackItem[],
): void {
  for (const raw of rawItems ?? []) {
    if (items.length >= RECENT_FEEDBACK_TARGET) break;
    const parsed = feedbackItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
  }
}

interface DayQueryResult {
  dateStr: string;
  rows: Record<string, unknown>[];
  errorName?: string;
}

async function queryDayPartition(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  dayOffset: number,
  now: Date,
): Promise<DayQueryResult> {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - dayOffset);
  const dateStr = d.toISOString().slice(0, 10);
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: feedbackTable,
        IndexName: FEEDBACK_BY_DATE_INDEX,
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': `DATE#${dateStr}` },
        ScanIndexForward: false,
        Limit: RECENT_FEEDBACK_TARGET,
      }),
    );
    return { dateStr, rows: resp.Items ?? [] };
  } catch (err) {
    return { dateStr, rows: [], errorName: err instanceof Error ? err.name : 'UnknownError' };
  }
}

function hasPersistentFailure(results: DayQueryResult[]): boolean {
  return results.some(
    (r) => r.errorName !== undefined && PERSISTENT_QUERY_ERRORS.has(r.errorName),
  );
}

export async function fetchRecentFeedback(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
): Promise<FeedbackSummary> {
  const items: RecentFeedbackItem[] = [];
  const now = new Date();
  const batchStarts = Array.from(
    { length: Math.ceil(RECENT_FEEDBACK_LOOKBACK_DAYS / DAY_QUERY_BATCH_SIZE) },
    (_, idx) => idx * DAY_QUERY_BATCH_SIZE,
  );

  for (const batchStart of batchStarts) {
    if (items.length >= RECENT_FEEDBACK_TARGET) break;
    const batchEnd = Math.min(batchStart + DAY_QUERY_BATCH_SIZE, RECENT_FEEDBACK_LOOKBACK_DAYS);
    const offsets = Array.from({ length: batchEnd - batchStart }, (_, idx) => batchStart + idx);
    const results = await Promise.all(
      offsets.map((offset) => queryDayPartition(docClient, feedbackTable, offset, now)),
    );

    // Results are in day order (newest first), so recency priority is kept.
    for (const result of results) {
      if (result.errorName) {
        // The original bug's worst property was silence — make failures visible.
        console.warn(`fetchRecentFeedback: day query failed for ${result.dateStr}: ${result.errorName}`);
      } else {
        collectFeedbackRows(result.rows, items);
      }
    }
    if (hasPersistentFailure(results)) break;
  }

  if (items.length === 0) return { count: 0, promptSection: '' };

  const lines = items.slice(0, RECENT_FEEDBACK_PROMPT_LINES).map((item) => {
    const src = item.source_platform ?? 'unknown';
    const sent = item.sentiment_label ?? 'unknown';
    const cat = item.category ?? 'unknown';
    const text = (item.original_text ?? '').slice(0, 300);
    return `[${src}|${sent}|${cat}] ${text}`;
  });
  return { count: items.length, promptSection: `## Recent Customer Feedback\n${lines.join('\n\n')}\n\n` };
}
