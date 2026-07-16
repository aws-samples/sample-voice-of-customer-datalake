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

  it('sort_by=urgency orders high → medium → low', async () => {
    const items = [
      makeFeedbackItem({ urgency: 'low', feedback_id: 'l'.repeat(32) }),
      makeFeedbackItem({ urgency: 'high', feedback_id: 'h'.repeat(32) }),
      makeFeedbackItem({ urgency: 'medium', feedback_id: 'm'.repeat(32) }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { sort_by: 'urgency' },
      { days: 7 },
    );

    expect(result.items.map((i) => i.urgency)).toStrictEqual(['high', 'medium', 'low']);
  });

  it('aggregate mode returns distribution over ALL matches, not a capped list', async () => {
    // 40 items: 10 high, 30 low — more than the 30-item list cap.
    const items = Array.from({ length: 40 }, (_, i) =>
      makeFeedbackItem({
        feedback_id: `id${String(i).padStart(30, '0')}`,
        urgency: i < 10 ? 'high' : 'low',
        sentiment_label: i < 10 ? 'negative' : 'positive',
      }),
    );
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { mode: 'aggregate' },
      { days: 7 },
    );

    // Stats reflect the full set of 40, even though only example items are listed.
    expect(result.formatted).toContain('ALL 40');
    expect(result.formatted).toContain('high: 10');
    expect(result.formatted).toContain('low: 30');
    // Examples are urgency-sorted, so the first shown is a high-urgency item.
    expect(result.items[0].urgency).toBe('high');
  });

  it('paginates via LastEvaluatedKey so a day larger than one page is not truncated', async () => {
    // Regression: a day with thousands of rows was truncated to the first page
    // (DynamoDB 1MB cap) → "987 negative but tool only saw 116". The fetch must
    // follow LastEvaluatedKey to collect every row.
    const page1 = Array.from({ length: 5 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `p1${String(i).padStart(30, '0')}`, sentiment_label: 'negative' }),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `p2${String(i).padStart(30, '0')}`, sentiment_label: 'negative' }),
    );
    let call = 0;
    const docClient = {
      send: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) return Promise.resolve({ Items: page1, LastEvaluatedKey: { k: 'next' } });
        if (call === 2) return Promise.resolve({ Items: page2 }); // no LastEvaluatedKey → stop
        return Promise.resolve({ Items: [] });
      }),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { sentiment: 'negative', limit: 30 },
      { days: 1 },
    );

    // Both pages collected (10 total), not just page 1's 5.
    expect(result.items).toHaveLength(10);
  });

  it('parses items whose numerics are stored as DynamoDB strings (regression: every search returned 0)', async () => {
    // The ingestion pipeline stores rating/sentiment_score as strings ("5",
    // "0.95"). A strict z.number() rejected these, dropping all candidates.
    const items = [
      makeFeedbackItem({ rating: '5' as unknown as number, sentiment_score: '0.95' as unknown as number, urgency: 'high' }),
      makeFeedbackItem({ rating: '2' as unknown as number, sentiment_score: '-0.8' as unknown as number, urgency: 'high', feedback_id: 'x'.repeat(32) }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { urgency: 'high' },
      { days: 7 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].sentiment_score).toBe(0.95);
    expect(result.items[0].rating).toBe(5);
  });

  it('skips a malformed row without discarding the rest of the day', async () => {
    const items = [
      makeFeedbackItem({ feedback_id: 'good1'.padEnd(32, '0') }),
      { not: 'a feedback item', original_text: 12345 }, // unparseable shape
      makeFeedbackItem({ feedback_id: 'good2'.padEnd(32, '0') }),
    ];
    const docClient = createMockDocClient([items as Record<string, unknown>[]]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      {},
      { days: 7 },
    );

    // The two valid rows survive even though the middle one is malformed.
    expect(result.items.length).toBeGreaterThanOrEqual(2);
  });

  it('aggregate mode reports no-match cleanly', async () => {
    const items = [makeFeedbackItem({ original_text: 'ok', title: 'ok', problem_summary: '' })];
    const docClient = createMockDocClient([items]);

    const result = await executeSearchFeedback(
      docClient,
      'test-feedback-table',
      { mode: 'aggregate', query: 'zzz_nope_zzz' },
      { days: 7 },
    );

    expect(result.items).toHaveLength(0);
    expect(result.formatted).toContain('No feedback found');
  });
});


describe('date basis (issue #150)', () => {
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  it('keeps freshly imported old reviews on the default (imported) basis', async () => {
    const backfilled = makeFeedbackItem({
      feedback_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      date: today,
      source_created_at: `${daysAgo(400)}T10:00:00Z`,
    });
    const docClient = createMockDocClient([[backfilled]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 7 },
    );

    expect(result.items).toHaveLength(1);
  });

  it('drops backfilled old reviews on review basis', async () => {
    const fresh = makeFeedbackItem({
      feedback_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      original_text: 'fresh review text',
      source_created_at: `${daysAgo(1)}T10:00:00Z`,
    });
    const backfilled = makeFeedbackItem({
      feedback_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      original_text: 'ancient review text',
      source_created_at: `${daysAgo(400)}T10:00:00Z`,
    });
    const docClient = createMockDocClient([[fresh, backfilled]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 7, dateBasis: 'review' },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].original_text).toBe('fresh review text');
  });

  it('falls back to the import date when source_created_at is malformed', async () => {
    const weird = makeFeedbackItem({
      feedback_id: 'cccccccccccccccccccccccccccccccc',
      date: today,
      source_created_at: 'unavailable-forever',
    });
    const docClient = createMockDocClient([[weird]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 7, dateBasis: 'review' },
    );

    // Import date is today => in-window via the fallback, and no garbage
    // lexicographic comparison sneaks it through on its own.
    expect(result.items).toHaveLength(1);
  });

  it('uses a days-long window ending today (unified definition)', async () => {
    // Item imported exactly `days` days ago sits just outside the window
    // (the old definition spanned days+1 calendar days and kept it).
    const boundary = makeFeedbackItem({
      feedback_id: 'dddddddddddddddddddddddddddddddd',
      date: daysAgo(7),
      source_created_at: `${daysAgo(7)}T10:00:00Z`,
    });
    const inWindow = makeFeedbackItem({
      feedback_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      date: daysAgo(6),
      source_created_at: `${daysAgo(6)}T10:00:00Z`,
    });
    // The date loop only queries in-window partitions; simulate both items
    // arriving from the scans regardless so the cutoff does the work.
    const docClient = createMockDocClient([[boundary, inWindow]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 7 },
    );

    expect(result.items.map((i) => i.feedback_id)).toStrictEqual([
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ]);
  });
});
