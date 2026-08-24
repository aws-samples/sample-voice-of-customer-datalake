/**
 * Tests for search_feedback tool implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeSearchFeedback,
  DAY_SCAN_CONCURRENCY,
  MAX_CANDIDATES,
  MAX_LOOKBACK_DAYS,
} from './search-feedback.js';

/**
 * The candidate cap the truncation cases inject.
 *
 * Three rows reach the cap-hit branches that MAX_CANDIDATES needed ten thousand
 * zod-parsed fixtures apiece to reach. Kept far below MAX_CANDIDATES, and
 * asserted so, since a TEST_CAP that drifted up to the real value would put the
 * 10k fixtures back without anyone noticing.
 */
const TEST_CAP = 3;

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

/**
 * Freeze the clock for the window tests, so the dates the scan computes and the
 * dates the assertions expect are the same instant.
 *
 * Without this the two read `new Date()` at different moments and a run
 * straddling UTC midnight flips `toContain(daysAgo(89))` — a once-a-day CI flake
 * that never reproduces. Same convention as src/context/voc-context.test.ts.
 *
 * Pinned to midday on the date this module loaded rather than a hard-coded
 * calendar day, because `today` and `makeFeedbackItem`'s default `date` are
 * module-scope constants read off the real clock: a fixed instant elsewhere in
 * the calendar would put every default fixture outside the window.
 */
const PINNED_NOW = new Date(`${today}T12:00:00.000Z`);

function freezeClock() {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe('lookback window (matches shared/feedback.py MAX_LOOKBACK_DAYS)', () => {
  freezeClock();

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

  it('filters on the window it scanned, not the one it was asked for', async () => {
    // The clamp and the cutoff must spend ONE number. When they disagreed the
    // filter admitted a year of items over a scan that read 90 days of them, so
    // whatever the scan happened to return was presented as the full year
    // (metrics_handler.py:705-712 records the same bug on the Python side).
    // This mock answers every partition with the same 200-day-old row, so only
    // the cutoff can exclude it.
    const ancient = makeFeedbackItem({
      feedback_id: 'g'.repeat(32),
      date: daysAgo(200),
      source_created_at: `${daysAgo(200)}T10:00:00Z`,
    });
    const docClient = createMockDocClient([[ancient]]);

    const result = await executeSearchFeedback(
      docClient, 'test-feedback-table', {}, { days: 365 },
    );

    expect(result.items).toHaveLength(0);
  });

  it('says which window it read when the request exceeded the bound', async () => {
    // A clamped window is unread remainder like any other: 275 days of what was
    // asked about were never queried, so an unhedged answer is a false claim.
    const { client } = createDateAwareDocClient({
      [daysAgo(1)]: [makeFeedbackItem({ date: daysAgo(1) })],
    });

    const result = await executeSearchFeedback(
      client, 'test-feedback-table', { mode: 'aggregate' }, { days: 365 },
    );

    expect(result.isPartial).toBe(true);
    expect(result.formatted).not.toContain('COMPLETE set');
    expect(result.formatted).toContain('most recent 90 days of the 365-day window');
    expect(result.formatted).toContain('name the 90-day window');
  });
});

describe('the day scan is bounded-concurrent, not sequential', () => {
  freezeClock();

  it('drives the cap branches with an injected budget, not the production one', () => {
    // The override is what lets the truncation cases above use 3-row fixtures
    // instead of 10 000 each. If TEST_CAP ever drifted up to the real value the
    // fixtures would silently balloon again; if MAX_CANDIDATES drifted down to a
    // handful, production would report truncation on ordinary windows.
    expect(TEST_CAP).toBeLessThan(MAX_CANDIDATES);
    expect(MAX_CANDIDATES).toBe(10000);
  });

  /** Counts how many sends are in flight at once, so overlap is observable. */
  function createOverlapTrackingDocClient() {
    const inFlight = { now: 0, max: 0 };
    const client = {
      send: vi.fn().mockImplementation(() => {
        inFlight.now += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        return Promise.resolve({ Items: [] }).finally(() => {
          inFlight.now -= 1;
        });
      }),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
    return { client, inFlight };
  }

  it('overlaps day reads in waves instead of awaiting one at a time', async () => {
    // 90 sequential round trips sat in front of a half-rendered chat turn. At a
    // 12ms round trip that measured p99 1092ms sequential against 153ms in waves
    // of 8 — less even than the 30-day sequential scan this widening replaced.
    const { client, inFlight } = createOverlapTrackingDocClient();

    await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 90 });

    // Both assertions carry weight and neither suffices alone. The first catches
    // a return to sequential reads; comparing only against the imported constant
    // would NOT, because setting it to 1 satisfies the equality — a green result
    // meaning "did not check". The second catches an unbounded fan-out, or drift
    // from the declared width.
    expect(inFlight.max).toBeGreaterThan(1);
    expect(inFlight.max).toBe(DAY_SCAN_CONCURRENCY);
    expect(client.send).toHaveBeenCalledTimes(90);
  });

  it('never exceeds the declared width, even on a window that is not a whole number of waves', async () => {
    // 90 / 8 leaves a final wave of 2. A chunker that mishandled the remainder
    // could dispatch it alongside the previous wave.
    const { client, inFlight } = createOverlapTrackingDocClient();

    await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 90 });

    expect(inFlight.max).toBeLessThanOrEqual(DAY_SCAN_CONCURRENCY);
  });

  it('keeps candidates in date order, newest first, despite concurrent reads', async () => {
    // Concurrency must not reorder results: list mode's default 'recent' sort IS
    // the scan order, so completion-order accumulation would silently shuffle
    // what the model is shown. Days resolve in reverse order here to force it.
    const byDate = Object.fromEntries(
      [1, 2, 3].map((n) => [daysAgo(n), [makeFeedbackItem({
        feedback_id: `${n}`.repeat(32),
        date: daysAgo(n),
        source_created_at: `${daysAgo(n)}T10:00:00Z`,
      })]]),
    );
    const client = {
      send: vi.fn().mockImplementation((command: { input: Record<string, unknown> }) => {
        const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, string>;
        const date = (values[':pk'] ?? '').replace('DATE#', '');
        const items = byDate[date] ?? [];
        // Newer days settle LAST: each awaits more microtask turns than the day
        // before it, so completion order is the reverse of date order. Microtasks
        // rather than timers because these tests run on fake timers.
        const settleOrder: Record<string, number> = { [daysAgo(1)]: 3, [daysAgo(2)]: 2 };
        const turns = settleOrder[date] ?? 1;
        return Array.from({ length: turns }).reduce<Promise<{ Items: unknown[] }>>(
          (p) => p.then((v) => v),
          Promise.resolve({ Items: items }),
        );
      }),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

    const result = await executeSearchFeedback(client, 'test-feedback-table', {}, { days: 5 });

    expect(result.items.map((i) => i.date)).toStrictEqual([daysAgo(1), daysAgo(2), daysAgo(3)]);
  });

  it('honours the shared candidate budget across concurrent days, not per day', async () => {
    // The reason concurrency is safe here at all. A per-day slice of the budget
    // would let each in-flight day spend the whole remainder — 8 x the cap held
    // at once, which is exactly what the cap exists to prevent. One counter,
    // charged as pages land, so the total is bounded however wide the fan-out.
    const rows = Array.from({ length: 4 }, (_, i) =>
      makeFeedbackItem({ feedback_id: `d${String(i).padStart(31, '0')}` }),
    );
    const client = {
      send: vi.fn().mockImplementation(() => Promise.resolve({ Items: rows })),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

    const result = await executeSearchFeedback(
      client, 'test-feedback-table', { mode: 'aggregate' }, { days: 90 }, TEST_CAP,
    );

    // One wave of 8 days x 4 rows is all that may be collected: the budget is
    // gone, so wave 2 is never dispatched. Per-day budgeting would keep going.
    expect(client.send).toHaveBeenCalledTimes(DAY_SCAN_CONCURRENCY);
    expect(result.isPartial).toBe(true);
  });
});

describe('truncation is reported (mirrors metrics_handler._scan_recent_items is_partial)', () => {
  freezeClock();

  /**
   * One page big enough to reach the candidate cap, optionally with more to come.
   *
   * Sized from TEST_CAP, which every case below passes to `executeSearchFeedback`
   * as its cap. Sizing from MAX_CANDIDATES instead meant 10 000 zod-parsed
   * fixtures per test and ~40 000 across the file, all of it incidental to what
   * is being asserted — and it scaled with any future rise in the cap. The
   * injected cap keeps the fixture honest without keeping it huge: it is still
   * "one page that exactly fills the budget", just a smaller budget.
   */
  function createCappedDocClient(hasMorePages: boolean) {
    const page = Array.from({ length: TEST_CAP }, (_, i) =>
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
      createCappedDocClient(true), 'test-feedback-table', {}, { days: 1 }, TEST_CAP,
    );

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('more feedback than the candidate budget allowed');
  });

  it('flags the cap ending the scan with days still unread', async () => {
    // Day 0 fills the budget on a single page (no LastEvaluatedKey), so the day
    // itself was complete — but days 1..89 were never read.
    const result = await executeSearchFeedback(
      createCappedDocClient(false), 'test-feedback-table', {}, { days: 90 }, TEST_CAP,
    );

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('older days still unread');
  });

  it('does not flag a single-day window the cap ended: nothing was left unread', async () => {
    const result = await executeSearchFeedback(
      createCappedDocClient(false), 'test-feedback-table', {}, { days: 1 }, TEST_CAP,
    );

    expect(result.isPartial).toBe(false);
  });

  it('flags a day that could not be read, rather than treating it as empty', async () => {
    // A throttle or 500 on one partition is survived so the other 89 days are
    // not lost — but survival without a report is how a sample comes back
    // claiming to be complete. Tripling the round trips makes this likelier.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failedDate = daysAgo(3);
    const docClient = {
      send: vi.fn().mockImplementation((command: { input: Record<string, unknown> }) => {
        const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, string>;
        return (values[':pk'] ?? '') === `DATE#${failedDate}`
          ? Promise.reject(new RangeError('ProvisionedThroughputExceededException'))
          : Promise.resolve({ Items: [] });
      }),
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

    const result = await executeSearchFeedback(docClient, 'test-feedback-table', {}, { days: 7 });

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('at least one day could not be read');
    // The cause reaches the operator log, never the model-facing prose: an
    // exception name is infrastructure detail (voc-context.ts states the rule).
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`DATE#${failedDate}`));
    expect(result.formatted).not.toContain('RangeError');
    warn.mockRestore();
  });

  it('flags rows the schema rejected: a discarded row is not a read one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [
      makeFeedbackItem({ feedback_id: 'good1'.padEnd(32, '0') }),
      { original_text: 12345 },
    ];

    const result = await executeSearchFeedback(
      createMockDocClient([rows as Record<string, unknown>[]]), 'test-feedback-table', {}, { days: 7 },
    );

    expect(result.items).toHaveLength(1);
    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('could not be parsed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 unparseable rows'));
    warn.mockRestore();
  });

  it('puts the warning in the formatted text the model reads, not just the object', async () => {
    // A flag that stays out of `formatted` changes nothing for the user: the
    // model is the only consumer of this tool result.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', { limit: 5 }, { days: 30 }, TEST_CAP,
    );

    expect(result.formatted).toContain('INCOMPLETE RESULTS');
    expect(result.formatted).toContain('30-day window');
  });

  it('aggregate mode drops its "COMPLETE set" claim when the scan was truncated', async () => {
    // The dangerous sentence: unqualified, it tells the model to treat capped
    // counts as the whole dataset.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', { mode: 'aggregate' }, { days: 90 }, TEST_CAP,
    );

    expect(result.isPartial).toBe(true);
    expect(result.formatted).not.toContain('COMPLETE set');
    expect(result.formatted).toContain('PARTIAL');
    expect(result.formatted).toContain('scan truncated');
  });

  it('states the truncation once, not once per formatter', async () => {
    // Three statements of one fact in the highest-attention region of the tool
    // result dilute rather than reinforce, and leave two wordings to sync. The
    // aggregate header flags PARTIAL and annotates the total; the imperative to
    // relay it belongs to truncationNotice alone.
    const result = await executeSearchFeedback(
      createCappedDocClient(true), 'test-feedback-table', { mode: 'aggregate' }, { days: 90 }, TEST_CAP,
    );

    expect(result.formatted.match(/Say so when you answer/g)).toHaveLength(1);
    expect(result.formatted.match(/⚠️/g)).toHaveLength(2);
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
