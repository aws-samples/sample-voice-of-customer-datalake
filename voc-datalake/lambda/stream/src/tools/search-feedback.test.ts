/**
 * Tests for search_feedback tool implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSearchFeedback, MAX_LOOKBACK_DAYS } from './search-feedback.js';

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

/** YYYY-MM-DD `n` days before today, UTC — the shape the date GSI partitions by. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

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


// ── The lookback window, and saying when the answer is capped ──
//
// Two halves of one defect: the day loop clamped at 30 while the REST routes
// read `MAX_LOOKBACK_DAYS = 90` (lambda/shared/feedback.py), so the chat tool
// answered "last quarter" from a month of feedback — and reported none of its
// three stopping points, so a capped answer was indistinguishable from a
// complete one. Widening the window without the notice makes that worse, hence
// both here. The Python↔TypeScript pin lives in
// lambda/shared/test/test_lookback_window_lockstep.py.

/** A mock that answers per date partition, so day-loop reach is observable. */
function createDateAwareDocClient(itemsByDate: Record<string, Record<string, unknown>[]>) {
  const queriedDates: string[] = [];
  const client = {
    send: vi.fn().mockImplementation((command: { input: Record<string, unknown> }) => {
      const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, string>;
      const pk = values[':pk'] ?? '';
      const date = pk.replace('DATE#', '');
      queriedDates.push(date);
      return Promise.resolve({ Items: itemsByDate[date] ?? [] });
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  return { client, queriedDates };
}

describe('lookback window (matches shared/feedback.py MAX_LOOKBACK_DAYS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares the same bound the Python routes enforce', () => {
    // Pinned to shared/feedback.py from the Python side; asserted here too so
    // the TypeScript suite fails loudly if the constant is edited alone.
    expect(MAX_LOOKBACK_DAYS).toBe(90);
  });

  it('finds an item 60 days old — the old 30-day clamp never queried its partition', async () => {
    const old = makeFeedbackItem({
      feedback_id: 'f'.repeat(32),
      date: daysAgo(60),
      source_created_at: `${daysAgo(60)}T10:00:00Z`,
    });
    const { client, queriedDates } = createDateAwareDocClient({ [daysAgo(60)]: [old] });

    const result = await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 90 });

    expect(queriedDates).toContain(daysAgo(60));
    expect(result.items.map((i) => i.feedback_id)).toStrictEqual(['f'.repeat(32)]);
  });

  it('scans at most MAX_LOOKBACK_DAYS partitions however many days are asked for', async () => {
    const { client, queriedDates } = createDateAwareDocClient({});

    await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 365 });

    expect(queriedDates).toHaveLength(MAX_LOOKBACK_DAYS);
    expect(queriedDates).toContain(daysAgo(MAX_LOOKBACK_DAYS - 1));
    expect(queriedDates).not.toContain(daysAgo(MAX_LOOKBACK_DAYS));
  });

  it('does not widen a narrow window: days=7 still reads 7 partitions', async () => {
    const { client, queriedDates } = createDateAwareDocClient({});

    await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 7 });

    expect(queriedDates).toHaveLength(7);
  });
});

describe('truncation is reported (mirrors metrics_handler._scan_recent_items is_partial)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One page big enough to reach MAX_CANDIDATES, optionally with more to come. */
  function createCappedDocClient(hasMorePages: boolean) {
    const page = Array.from({ length: 10000 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `c${String(i).padStart(31, '0')}` }),
    );
    let call = 0;
    return {
      send: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve(
            hasMorePages ? { Items: page, LastEvaluatedKey: { k: 'next' } } : { Items: page },
          );
        }
        return Promise.resolve({ Items: [] });
      }),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  }

  it('reports a complete scan as complete, with no hedging in the prose', async () => {
    const docClient = createMockDocClient([[makeFeedbackItem()]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 7 },
    );

    expect(result.isPartial).toBe(false);
    expect(result.formatted).not.toContain('INCOMPLETE');
    expect(result.formatted).not.toContain('partial');
  });

  it('flags a day whose partition still had pages when the candidate cap hit', async () => {
    // days=1 on purpose, so no day is left unread and the ONLY thing that can
    // set the flag is the unfinished partition — otherwise this passes on the
    // other branch and the day-level signal goes untested.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', {}, { days: 1 },
    );

    expect(result.isPartial).toBe(true);
  });

  it('flags the cap ending the scan with days still unread', async () => {
    // Day 0 fills the budget on a single page (no LastEvaluatedKey), so the day
    // itself was complete — but days 1..89 were never read.
    const result = await executeSearchFeedback(
      createCappedDocClient(false), 'test-feedback-table', {}, { days: 90 },
    );

    expect(result.isPartial).toBe(true);
  });

  it('does not flag a single-day window the cap ended: nothing was left unread', async () => {
    const result = await executeSearchFeedback(
      createCappedDocClient(false), 'test-feedback-table', {}, { days: 1 },
    );

    expect(result.isPartial).toBe(false);
  });

  it('puts the warning in the formatted text the model reads, not just the object', async () => {
    // A flag that stays out of `formatted` changes nothing for the user: the
    // model is the only consumer of this tool result.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', { limit: 5 }, { days: 30 },
    );

    expect(result.formatted).toContain('INCOMPLETE RESULTS');
    expect(result.formatted).toContain('30-day window');
  });

  it('aggregate mode drops its "COMPLETE set" claim when the scan was truncated', async () => {
    // The dangerous sentence: unqualified, it tells the model to treat capped
    // counts as the whole dataset.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', { mode: 'aggregate' }, { days: 90 },
    );

    expect(result.isPartial).toBe(true);
    expect(result.formatted).not.toContain('COMPLETE set');
    expect(result.formatted).toContain('PARTIAL');
    expect(result.formatted).toContain('scan truncated');
  });

  it('aggregate mode still claims completeness when the whole window was read', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `a${String(i).padStart(31, '0')}` }),
    );
    const result = await executeSearchFeedback(
      createMockDocClient([items]), 'test-feedback-table', { mode: 'aggregate' }, { days: 7 },
    );

    expect(result.isPartial).toBe(false);
    expect(result.formatted).toContain('COMPLETE set');
    expect(result.formatted).not.toContain('PARTIAL');
  });

  it('a feedback-ID hit is complete by construction', async () => {
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const docClient = createMockDocClient([[makeFeedbackItem({ feedback_id: feedbackId })]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', { query: feedbackId }, { days: 7 },
    );

    expect(result.isPartial).toBe(false);
  });
});
