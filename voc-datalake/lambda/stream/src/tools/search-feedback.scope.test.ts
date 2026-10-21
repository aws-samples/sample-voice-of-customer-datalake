/**
 * The chat filter panel's scope as a hard floor on search_feedback: the model's
 * own tool input narrows within it but cannot widen past it. Split from
 * search-feedback.test.ts to keep each file under the line cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSearchFeedback } from './search-feedback.js';
import { EMPTY_CHAT_FILTERS, type ChatFilters } from '../context/feedback-filters.js';

function createMockDocClient(queryResponses: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const items = callIndex < queryResponses.length ? queryResponses[callIndex] : [];
      callIndex++;
      return Promise.resolve({ Items: items });
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

const today = new Date().toISOString().slice(0, 10);

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    feedback_id: 'abc123def456abc123def456abc12345',
    source_platform: 'webscraper',
    source_created_at: `${today}T10:00:00Z`,
    sentiment_label: 'negative',
    sentiment_score: -0.8,
    category: 'delivery',
    original_text: 'text',
    date: today,
    urgency: 'high',
    ...overrides,
  };
}

function scope(partial: Partial<ChatFilters>): ChatFilters {
  return { ...EMPTY_CHAT_FILTERS, ...partial };
}

describe('executeSearchFeedback panel scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes a source the model asked for but the scope forbids', async () => {
    const items = [
      makeItem({ source_platform: 'webscraper', feedback_id: 'ws01' }),
      makeItem({ source_platform: 'manual_import', feedback_id: 'mi01' }),
      makeItem({ source_platform: 's3_import', feedback_id: 's301' }),
    ];
    const docClient = createMockDocClient([items]);

    // Model input tries to widen to s3_import; the scope allows only two sources.
    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { source: 's3_import' },
      { days: 7, scope: scope({ sources: ['webscraper', 'manual_import'] }) },
    );

    expect(result.items.map((i) => i.feedback_id)).toStrictEqual([]);
  });

  it('keeps only the scope-allowed sources when the model narrows within it', async () => {
    const items = [
      makeItem({ source_platform: 'webscraper', feedback_id: 'ws01' }),
      makeItem({ source_platform: 'manual_import', feedback_id: 'mi01' }),
      makeItem({ source_platform: 's3_import', feedback_id: 's301' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      {},
      { days: 7, scope: scope({ sources: ['webscraper', 'manual_import'] }) },
    );

    expect(result.items.map((i) => i.feedback_id).sort()).toStrictEqual(['mi01', 'ws01']);
  });

  it('applies a usefulness scope, treating a missing value as unscored', async () => {
    const items = [
      makeItem({ usefulness: 'high', feedback_id: 'hi01' }),
      makeItem({ usefulness: 'low', feedback_id: 'lo01' }),
      makeItem({ feedback_id: 'no01' }),  // no usefulness → unscored
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      {},
      { days: 7, scope: scope({ usefulness: ['high', 'unscored'] }) },
    );

    expect(result.items.map((i) => i.feedback_id).sort()).toStrictEqual(['hi01', 'no01']);
  });
})
