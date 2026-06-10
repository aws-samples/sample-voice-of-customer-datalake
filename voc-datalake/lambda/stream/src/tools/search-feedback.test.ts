/**
 * Tests for search_feedback tool implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSearchFeedback } from './search-feedback.js';

// Mock DynamoDB document client
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

function makeFeedbackItem(overrides: Record<string, unknown> = {}) {
  return {
    feedback_id: 'abc123def456abc123def456abc12345',
    source_platform: 'webscraper',
    source_created_at: `${today}T10:00:00Z`,
    sentiment_label: 'negative',
    sentiment_score: -0.8,
    category: 'delivery',
    rating: 2,
    original_text: 'My package arrived late and damaged',
    title: 'Late delivery',
    problem_summary: 'Package delayed and damaged',
    date: today,
    urgency: 'high',
    ...overrides,
  };
}

describe('executeSearchFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ConfigurationError when feedback table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      executeSearchFeedback(docClient, '', {}, { days: 7 }),
    ).rejects.toThrow('Feedback table not configured');
  });

  it('returns formatted results for matching feedback', async () => {
    const items = [makeFeedbackItem()];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { query: 'delivery' },
      { days: 7 },
    );

    expect(result.items).toHaveLength(1);
    expect(result.formatted).toContain('delivery');
    expect(result.formatted).toContain('Found 1 relevant feedback');
  });

  it('returns no-match message when nothing matches', async () => {
    const items = [makeFeedbackItem({ original_text: 'Great product', title: 'Love it', problem_summary: '' })];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { query: 'zzz_nonexistent_zzz' },
      { days: 7 },
    );

    expect(result.items).toHaveLength(0);
    expect(result.formatted).toContain('No feedback found');
  });

  it('applies source filter from context', async () => {
    const items = [
      makeFeedbackItem({ source_platform: 'webscraper' }),
      makeFeedbackItem({ source_platform: 'manual_import', feedback_id: 'other123' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      {},
      { source: 'webscraper', days: 7 },
    );

    expect(result.items.every((i) => i.source_platform === 'webscraper')).toBe(true);
  });

  it('applies sentiment filter from tool input', async () => {
    const items = [
      makeFeedbackItem({ sentiment_label: 'positive' }),
      makeFeedbackItem({ sentiment_label: 'negative', feedback_id: 'neg123' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { sentiment: 'positive' },
      { days: 7 },
    );

    expect(result.items.every((i) => i.sentiment_label === 'positive')).toBe(true);
  });

  it('respects limit parameter', async () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `id${String(i).padStart(30, '0')}ab` }),
    );
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { limit: 3 },
      { days: 7 },
    );

    expect(result.items.length).toBeLessThanOrEqual(3);
  });

  it('caps limit at 30', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `id${String(i).padStart(30, '0')}ab` }),
    );
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { limit: 100 },
      { days: 7 },
    );

    expect(result.items.length).toBeLessThanOrEqual(30);
  });

  it('attempts feedback ID lookup for 32-char hex strings', async () => {
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const item = makeFeedbackItem({ feedback_id: feedbackId });
    const docClient = createMockDocClient([[item]]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { query: feedbackId },
      { days: 7 },
    );

    expect(result.items).toHaveLength(1);
    expect(docClient.send).toHaveBeenCalledOnce();
  });

  it('handles gracefully when tool input is not an object', async () => {
    const items = [makeFeedbackItem()];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      'not an object',
      { days: 7 },
    );

    // Should not throw, falls back to empty input
    expect(result.items.length).toBeGreaterThanOrEqual(0);
  });
});
