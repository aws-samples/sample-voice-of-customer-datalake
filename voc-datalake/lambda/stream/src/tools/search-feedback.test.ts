/**
 * Tests for search_feedback tool implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DAY_SCAN_CONCURRENCY, MAX_LOOKBACK_DAYS, MAX_SAMPLE_WALK_DAYS } from './feedback-scan.js';
import { FEEDBACK_BY_ID_INDEX } from '../indexes.js';
import { nth } from '../lib/nth-fixtures.js';
import { executeSearchFeedback } from './search-feedback.js';
import {
  ALL_CATEGORIES,
  NO_PROSE_GAPS,
  TEST_CAP,
  createDateAwareDocClient,
  createMockDocClient,
  daysAgo,
  docClientRejecting,
  docClientReturning,
  fakeDocClient,
  type FakeDocClient,
  freezeClock,
  makeFeedbackItem,
  proseGaps,
  queriedDate,
  queriedIndexes,
  rowsWithIds,
  runSearch,
  spyWarn,
  today,
} from './feedback-test-fixtures.js';

describe('executeSearchFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ConfigurationError when feedback table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      executeSearchFeedback(docClient, '', {}, { scope: ALL_CATEGORIES, days: 7 }),
    ).rejects.toThrow('Feedback table not configured');
  });

  it('returns formatted results for matching feedback', async () => {
    const items = [makeFeedbackItem()];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { query: 'delivery' }, { days: 7 });

    expect(result.items).toHaveLength(1);
    expect(result.formatted).toContain('delivery');
    expect(result.formatted).toContain('Found 1 relevant feedback');
  });

  it('returns no-match message when nothing matches', async () => {
    const items = [makeFeedbackItem({ original_text: 'Great product', title: 'Love it', problem_summary: '' })];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { query: 'zzz_nonexistent_zzz' }, { days: 7 });

    expect(result.items).toHaveLength(0);
    expect(result.formatted).toContain('No feedback found');
  });

  it('applies source filter from context', async () => {
    const items = [
      makeFeedbackItem({ source_platform: 'webscraper' }),
      makeFeedbackItem({ source_platform: 'manual_import', feedback_id: 'other123' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, {}, { source: 'webscraper', days: 7 });

    expect(result.items.map((i) => i.feedback_id)).toStrictEqual(['abc123def456abc123def456abc12345']);
  });

  it('applies the software-version filter to GitHub Issues items', async () => {
    const items = [
      makeFeedbackItem({ source_platform: 'github_issues', issue_attributes: { software_version: '0.4.2' } }),
      makeFeedbackItem({ source_platform: 'github_issues', issue_attributes: { software_version: '0.4.1' }, feedback_id: 'old123' }),
      makeFeedbackItem({ feedback_id: 'none123' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { version: 'v0.4.2' }, { days: 7 });

    expect(result.items).toHaveLength(1);
    expect(nth(result.items, 0).source_platform).toBe('github_issues');
  });

  it('applies the channel, tag (case-insensitive) and dimension filters together', async () => {
    const items = [
      makeFeedbackItem({ feedback_id: 'hit123', source_channel: 'email', tags: ['VIP'], dimensions: { product: 'app', module: 'billing' } }),
      makeFeedbackItem({ feedback_id: 'chan123', source_channel: 'chat', tags: ['vip'], dimensions: { product: 'app' } }),
      makeFeedbackItem({ feedback_id: 'dims123', source_channel: 'email', tags: ['vip'], dimensions: { product: 'web' } }),
      makeFeedbackItem({ feedback_id: 'tags123', source_channel: 'email', dimensions: { product: 'app' } }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { channel: 'email', tag: 'vip', dims: { product: 'app' } }, { days: 7 });

    expect(result.items.map((item) => item.feedback_id)).toStrictEqual(['hit123']);
  });

  it('applies sentiment filter from tool input', async () => {
    const items = [
      makeFeedbackItem({ sentiment_label: 'positive' }),
      makeFeedbackItem({ sentiment_label: 'negative', feedback_id: 'neg123' }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { sentiment: 'positive' }, { days: 7 });

    expect(result.items.map((i) => i.feedback_id)).toStrictEqual(['abc123def456abc123def456abc12345']);
  });

  it('respects limit parameter', async () => {
    const items = rowsWithIds(20, 'id');
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { limit: 3 }, { days: 7 });

    expect(result.items).toHaveLength(3);
  });

  it('caps limit at 30', async () => {
    const items = rowsWithIds(50, 'id');
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { limit: 100 }, { days: 7 });

    expect(result.items).toHaveLength(30);
  });

  it('attempts feedback ID lookup for 32-char hex strings', async () => {
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const item = makeFeedbackItem({ feedback_id: feedbackId });
    const docClient = createMockDocClient([[item]]);

    const result = await runSearch(docClient, { query: feedbackId }, { days: 7 });

    expect(result.items).toHaveLength(1);
    expect(queriedIndexes(docClient.send)).toStrictEqual([FEEDBACK_BY_ID_INDEX]);
  });

  it('handles gracefully when tool input is not an object', async () => {
    const items = [makeFeedbackItem()];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, 'not an object', { days: 7 });

    // Does not throw: falls back to empty input, which admits the one row.
    expect(result.items).toHaveLength(1);
  });

  it('sort_by=urgency orders high → medium → low', async () => {
    const items = [
      makeFeedbackItem({ urgency: 'low', feedback_id: 'l'.repeat(32) }),
      makeFeedbackItem({ urgency: 'high', feedback_id: 'h'.repeat(32) }),
      makeFeedbackItem({ urgency: 'medium', feedback_id: 'm'.repeat(32) }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { sort_by: 'urgency' }, { days: 7 });

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

    const result = await runSearch(docClient, { mode: 'aggregate' }, { days: 7 });

    // Stats reflect the full set of 40, even though only example items are listed.
    expect(result.formatted).toContain('ALL 40');
    expect(result.formatted).toContain('high: 10');
    expect(result.formatted).toContain('low: 30');
    // Examples are urgency-sorted, so the first shown is a high-urgency item.
    expect(nth(result.items, 0).urgency).toBe('high');
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
    const docClient = fakeDocClient(() => {
        call++;
        if (call === 1) return Promise.resolve({ Items: page1, LastEvaluatedKey: { k: 'next' } });
        if (call === 2) return Promise.resolve({ Items: page2 }); // no LastEvaluatedKey → stop
        return Promise.resolve({ Items: [] });
      });

    const result = await runSearch(docClient, { sentiment: 'negative', limit: 30 }, { days: 1 });

    // Both pages collected (10 total), not just page 1's 5.
    expect(result.items).toHaveLength(10);
  });

  it('parses items whose numerics are stored as DynamoDB strings (regression: every search returned 0)', async () => {
    // The ingestion pipeline stores rating/sentiment_score as strings ("5",
    // "0.95"). A strict z.number() rejected these, dropping all candidates.
    const items = [
      makeFeedbackItem({ rating: '5', sentiment_score: '0.95', urgency: 'high' }),
      makeFeedbackItem({ rating: '2', sentiment_score: '-0.8', urgency: 'high', feedback_id: 'x'.repeat(32) }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { urgency: 'high' }, { days: 7 });

    expect(result.items).toHaveLength(2);
    expect(nth(result.items, 0).sentiment_score).toBe(0.95);
    expect(nth(result.items, 0).rating).toBe(5);
  });

  it('skips a malformed row without discarding the rest of the day', async () => {
    const items = [
      makeFeedbackItem({ feedback_id: 'good1'.padEnd(32, '0') }),
      { not: 'a feedback item', original_text: 12345 }, // unparseable shape
      makeFeedbackItem({ feedback_id: 'good2'.padEnd(32, '0') }),
    ];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, {}, { days: 7 });

    // The two valid rows survive even though the middle one is malformed.
    const survivors = result.items.map((i) => i.feedback_id);
    expect(survivors).toStrictEqual(['good1'.padEnd(32, '0'), 'good2'.padEnd(32, '0')]);
  });

  it('aggregate mode reports no-match cleanly', async () => {
    const items = [makeFeedbackItem({ original_text: 'ok', title: 'ok', problem_summary: '' })];
    const docClient = createMockDocClient([items]);

    const result = await runSearch(docClient, { mode: 'aggregate', query: 'zzz_nope_zzz' }, { days: 7 });

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

    const result = await runSearch(docClient, {}, { days: 7 });

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

    const result = await runSearch(docClient, {}, { days: 7, dateBasis: 'review' });

    expect(result.items).toHaveLength(1);
    expect(nth(result.items, 0).original_text).toBe('fresh review text');
  });

  it('falls back to the import date when source_created_at is malformed', async () => {
    const weird = makeFeedbackItem({
      feedback_id: 'cccccccccccccccccccccccccccccccc',
      date: today,
      source_created_at: 'unavailable-forever',
    });
    const docClient = createMockDocClient([[weird]]);

    const result = await runSearch(docClient, {}, { days: 7, dateBasis: 'review' });

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

    const result = await runSearch(docClient, {}, { days: 7 });

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

    const result = await runSearch(client, {}, { days: 90 });

    expect(queriedDates).toContain(daysAgo(60));
    expect(result.items.map((i) => i.feedback_id)).toStrictEqual(['f'.repeat(32)]);
  });

  it('walks past empty recent days: 365 empty days are 365 reads, not 90', async () => {
    // A 90-CALENDAR-day cap answered "last year" with nothing on a deployment
    // whose newest feedback is older than 90 days (shared/feedback.py 55bbaa1c).
    const { client, queriedDates } = createDateAwareDocClient({});

    await runSearch(client, {}, { days: 365 });

    expect(queriedDates).toHaveLength(365);
  });

  it('never walks further back than MAX_SAMPLE_WALK_DAYS', async () => {
    const { client, queriedDates } = createDateAwareDocClient({});

    await runSearch(client, {}, { days: 1000 });

    expect(queriedDates).toHaveLength(MAX_SAMPLE_WALK_DAYS);
    expect(queriedDates).toContain(daysAgo(MAX_SAMPLE_WALK_DAYS - 1));
    expect(queriedDates).not.toContain(daysAgo(MAX_SAMPLE_WALK_DAYS));
  });

  it('finds feedback 200 days old behind 200 empty days', async () => {
    const old = makeFeedbackItem({ feedback_id: 'o'.repeat(32), date: daysAgo(200), source_created_at: `${daysAgo(200)}T10:00:00Z` });
    const { client } = createDateAwareDocClient({ [daysAgo(200)]: [old] });

    const result = await runSearch(client, {}, { days: 365 });

    expect(result.items.map((i) => i.feedback_id)).toStrictEqual(['o'.repeat(32)]);
    expect(result.isPartial).toBe(false);
  });

  it('stops exactly after MAX_LOOKBACK_DAYS days WITH DATA, even mid-wave', async () => {
    // Every other day has a row: the 90th dated day is calendar day 178, which
    // sits inside a wave of 8 — the days after it in that wave are not kept.
    const byDate = Object.fromEntries(Array.from({ length: 200 }, (_, i) => i)
      .filter((i) => i % 2 === 0)
      .map((i) => [daysAgo(i), [makeFeedbackItem({ feedback_id: `${i}`.padStart(32, 'd'), date: daysAgo(i) })]]));
    const { client } = createDateAwareDocClient(byDate);

    const result = await runSearch(client, { mode: 'aggregate' }, { days: 365 });

    expect(result.formatted).toContain('**Total matches:** 90');
    expect(result.formatted).toContain('at most 179 days');
  });

  it('does not widen a narrow window: days=7 still reads 7 partitions', async () => {
    const { client, queriedDates } = createDateAwareDocClient({});

    await runSearch(client, {}, { days: 7 });

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
    // Every partition answers with the same 200-day-old row, so the walk stops
    // after MAX_LOOKBACK_DAYS dated days (90 calendar days here) and only the
    // cutoff — computed from the 90 days walked, not the 365 asked — excludes it.
    const docClient = docClientReturning([ancient]);

    const result = await runSearch(docClient, {}, { days: 365 });

    expect(result.items).toHaveLength(0);
  });

  /** One row yesterday, read with a window beyond MAX_SAMPLE_WALK_DAYS: only the clamp can hedge the answer. */
  function clampedWindowSearch(toolInput: unknown, filters: { days: number }) {
    const { client } = createDateAwareDocClient({ [daysAgo(1)]: [makeFeedbackItem({ date: daysAgo(1) })] });
    return runSearch(client, toolInput, filters);
  }

  it('says which window it read when the request exceeded the bound', async () => {
    // A clamped window is unread remainder like any other: 275 days of what was
    // asked about were never queried, so an unhedged answer is a false claim.
    const result = await clampedWindowSearch({ mode: 'aggregate' }, { days: 500 });

    expect(result.isPartial).toBe(true);
    expect(proseGaps(result.formatted, {
      has: ['NARROWER WINDOW THAN ASKED ABOUT', 'at most 400 days', 'the question named 500 days', '100 earlier days'],
    })).toStrictEqual(NO_PROSE_GAPS);
  });

  it('reports partial on the clamp alone, with no other cap in play', async () => {
    // One item, one page, no LastEvaluatedKey, far below the candidate cap, every
    // partition readable — so nothing except the clamp can set the flag, and this
    // assertion turns on the clamp alone. That state used to report a complete
    // answer over a fraction of the window asked about.
    const result = await clampedWindowSearch({}, { days: 500 });

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('at most 400 days');
  });

  it('does not call a clamped-but-fully-read window a truncated scan', async () => {
    // The distinction the clamp forces, and the one this used to get wrong: every
    // one of the 90 partitions was read to its end, so the totals ARE complete for
    // those 90 days. Calling them "a sample … NOT the complete set" and annotating
    // the total "scan truncated" describes a truncation that never happened — and
    // pairs a PARTIAL header with prose saying the figures are complete.
    const result = await clampedWindowSearch({ mode: 'aggregate' }, { days: 500 });

    expect(result.formatted).toContain('COMPLETE set');
    expect(result.formatted).not.toContain('PARTIAL —');
    expect(result.formatted).not.toContain('scan truncated');
    expect(result.formatted).not.toContain('INCOMPLETE RESULTS');
  });

  it('scans, filters and describes one and the same window', async () => {
    // The three used to be able to disagree: the scan read `min(days, 30)` while
    // the cutoff came from the caller's full `days`, so the filter admitted items
    // from partitions nothing had queried. Asserted over observable behaviour
    // rather than by reading the source — the partitions queried, the oldest item
    // the filter keeps, and the window the prose names must all agree.
    const inWindow = makeFeedbackItem({
      feedback_id: 'h'.repeat(32),
      date: daysAgo(MAX_LOOKBACK_DAYS - 1),
      source_created_at: `${daysAgo(MAX_LOOKBACK_DAYS - 1)}T10:00:00Z`,
    });
    const justOutside = makeFeedbackItem({
      feedback_id: 'i'.repeat(32),
      date: daysAgo(MAX_LOOKBACK_DAYS),
      source_created_at: `${daysAgo(MAX_LOOKBACK_DAYS)}T10:00:00Z`,
    });
    // Every day returns a row, so the walk stops after MAX_LOOKBACK_DAYS
    // calendar days; the oldest of them also serves a row one day older.
    const filler = (i: number) => [makeFeedbackItem({ feedback_id: `${i}`.padStart(32, 'f'), date: daysAgo(i), urgency: 'low' })];
    const { client, queriedDates } = createDateAwareDocClient({
      ...Object.fromEntries(Array.from({ length: MAX_LOOKBACK_DAYS - 1 }, (_, i) => [daysAgo(i), filler(i)])),
      [daysAgo(MAX_LOOKBACK_DAYS - 1)]: [inWindow, justOutside],
    });

    const result = await runSearch(client, { mode: 'aggregate' }, { days: 365 });

    // Whole waves are read; the days past the 90th dated one are dropped.
    expect(queriedDates).toHaveLength(Math.ceil(MAX_LOOKBACK_DAYS / DAY_SCAN_CONCURRENCY) * DAY_SCAN_CONCURRENCY);
    // 89 fillers + inWindow; justOutside (dated one day before the walk) is filtered out.
    expect(result.formatted).toContain(`**Total matches:** ${MAX_LOOKBACK_DAYS}`);
    expect(result.formatted).toContain(`at most ${MAX_LOOKBACK_DAYS} days`);
  });
});

/** A DynamoDB failure the scan classifies by `name` (query-errors.ts). */
function namedError(name: string, message: string): RangeError {
  const error = new RangeError(message);
  error.name = name;
  return error;
}

/** Every day of the index refused: the systemic failure the scan short-circuits on. */
function accessDeniedDocClient(): FakeDocClient {
  return docClientRejecting(namedError('AccessDeniedException', 'denied'));
}

const GOOD_ROW = makeFeedbackItem({ feedback_id: 'good1'.padEnd(32, '0') });
/** A row the feedback schema rejects: `original_text` is not a string. */
const UNPARSEABLE_ROW = { original_text: 12345 };

/** The truncation notice and its imperative appear exactly once each (see the aggregate case). */
function expectTruncationStatedOnce(formatted: string): void {
  expect(formatted.match(/Say so when you answer/g)).toHaveLength(1);
  expect(formatted.match(/INCOMPLETE RESULTS/g)).toHaveLength(1);
}

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
    const page = rowsWithIds(TEST_CAP, 'c');
    let call = 0;
    return fakeDocClient(() => {
        call++;
        if (call === 1) {
          return Promise.resolve(
            hasMorePages ? { Items: page, LastEvaluatedKey: { k: 'next' } } : { Items: page },
          );
        }
        return Promise.resolve({ Items: [] });
      });
  }

  it('reports a complete scan as complete, with no hedging in the prose', async () => {
    const docClient = createMockDocClient([[makeFeedbackItem()]]);

    const result = await runSearch(docClient, {}, { days: 7 });

    expect(result.isPartial).toBe(false);
    expect(result.formatted).not.toContain('INCOMPLETE');
    // The hedging strings themselves, not the bare word `partial`: `formatted`
    // embeds up to 400 characters of arbitrary customer text per item, so a
    // fixture whose feedback happened to mention the word would fail this for no
    // behaviour change at all.
    expect(result.formatted).not.toContain('scan truncated');
    expect(result.formatted).not.toContain('PARTIAL');
  });

  it('flags a day whose partition still had pages when the candidate cap hit', async () => {
    // days=1 on purpose, so no day is left unread and the ONLY thing that can
    // set the flag is the unfinished partition — otherwise this passes on the
    // other branch and the day-level signal goes untested.
    const result = await runSearch(createCappedDocClient(true), {}, { days: 1 }, TEST_CAP);

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('more feedback than the candidate budget allowed');
  });

  it('flags the cap ending the scan with days still unread', async () => {
    // Day 0 fills the budget on a single page (no LastEvaluatedKey), so the day
    // itself was complete — but days 1..89 were never read.
    const result = await runSearch(createCappedDocClient(false), {}, { days: 90 }, TEST_CAP);

    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('older days still unread');
  });

  it('does not flag a single-day window the cap ended: nothing was left unread', async () => {
    const result = await runSearch(createCappedDocClient(false), {}, { days: 1 }, TEST_CAP);

    expect(result.isPartial).toBe(false);
  });

  it('flags a day that could not be read, rather than treating it as empty', async () => {
    // A throttle or 500 on one partition is survived so the other 89 days are
    // not lost — but survival without a report is how a sample comes back
    // claiming to be complete. Tripling the round trips makes this likelier.
    const warn = spyWarn();
    const failedDate = daysAgo(3);
    const docClient = fakeDocClient((command) => {
        return queriedDate(command) === failedDate
          ? Promise.reject(new RangeError('ProvisionedThroughputExceededException'))
          : Promise.resolve({ Items: [] });
      });

    const result = await runSearch(docClient, {}, { days: 7 });

    // A transient name is one partition's bad luck, so the other days are still
    // read — the throttle must not cost the window.
    expect({ isPartial: result.isPartial, dayReads: docClient.send.mock.calls.length })
      .toStrictEqual({ isPartial: true, dayReads: 7 });
    // The cause reaches the operator log, never the model-facing prose: an
    // exception name is infrastructure detail.
    expect(proseGaps(result.formatted, { has: ['at least one day could not be read'], lacks: ['RangeError'] }))
      .toStrictEqual(NO_PROSE_GAPS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(failedDate));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RangeError'));
    warn.mockRestore();
  });

  it('stops on a systemic failure instead of repeating it for every wave', async () => {
    // A missing grant fails identically for every partition of the index, so the
    // remaining waves only repeat it and one log line per day says nothing the
    // first said (query-errors.ts states both consequences).
    const warn = spyWarn();
    const docClient = accessDeniedDocClient();

    const result = await runSearch(docClient, {}, { days: 90 });

    // The first wave was dispatched before the fault was known; the other ten
    // never were.
    expect(docClient.send).toHaveBeenCalledTimes(DAY_SCAN_CONCURRENCY);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('AccessDeniedException'));
    expect(result.isPartial).toBe(true);
    warn.mockRestore();
  });

  it('says the window is unmeasured, not empty, when no day could be read', async () => {
    // Nothing was measured, so zero is not a finding: query-errors.ts requires a
    // consumer to "treat the numbers it leaves behind as unmeasured rather than
    // as zero", and a user asking how much negative feedback arrived must not be
    // told there was none when the tool could not look.
    const warn = spyWarn();
    const docClient = accessDeniedDocClient();

    const result = await runSearch(docClient, { mode: 'aggregate' }, { days: 90 });

    expect(result.items).toHaveLength(0);
    expect(result.isPartial).toBe(true);
    expect(proseGaps(result.formatted, {
      has: ['no day of the 90-day window could be read', 'NOT a result of zero feedback items'],
      lacks: ['No feedback found'],
    })).toStrictEqual(NO_PROSE_GAPS);
    warn.mockRestore();
  });
  it('keeps the rows a day read before its later page failed, instead of calling the window unmeasured', async () => {
    // The negative twin of the test above, and the case that made the honesty
    // machinery lie in the OTHER direction: every day here answers its first page
    // and fails its second, so a classification keyed on "did this day end with an
    // error" counted all 90 as never read, `unmeasured` fired, and every collected
    // row was discarded behind "the store could not be reached" — 450 rows read,
    // zero reported. `fetchDayPages` promises the opposite in its own docstring
    // ("a partition whose second page fails must keep what its first page
    // measured"), so this pins it.
    const warn = spyWarn();
    const rows = rowsWithIds(5, 'p');
    const throttled = namedError('ProvisionedThroughputExceededException', 'throttled');
    const docClient = fakeDocClient((command) =>
        // A transient name, so the scan is not short-circuited and every day of the
        // window contributes — which is what makes discarding them all measurable.
        (command.input.ExclusiveStartKey === undefined
          ? Promise.resolve({ Items: rows, LastEvaluatedKey: { pk: 'page2' } })
          : Promise.reject(throttled)));
    const result = await runSearch(docClient, { mode: 'aggregate' }, { days: 90 });
    // What the rows bought: an answer, not an absence.
    expect(result.items.length).toBeGreaterThan(0);
    // And the hole is still declared — surviving a failure is only honest if the
    // survival is reported, so this must not become a silent success either.
    expect(result.isPartial).toBe(true);
    expect(proseGaps(result.formatted, {
      has: ['at least one day could not be read'],
      lacks: ['THE SEARCH COULD NOT BE RUN', 'could not be read, so nothing is known'],
    })).toStrictEqual(NO_PROSE_GAPS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ProvisionedThroughputExceededException'),
    );
    warn.mockRestore();
  });

  it('logs rows the schema rejected, with the count and the date', async () => {
    // The row is a real loss and an operator must be able to find and repair it.
    const warn = spyWarn();
    const rows = [GOOD_ROW, UNPARSEABLE_ROW];

    const result = await runSearch(createMockDocClient([rows]), {}, { days: 7 });

    expect(result.items).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 unparseable row(s) across 1 day(s)'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(today));
    warn.mockRestore();
  });

  it('does not call the whole window a sample over one unparseable row', async () => {
    // A malformed legacy row fails identically on every future call, so folding
    // it into isPartial would hedge every answer forever over a window that was
    // read end to end — and a flag that always fires carries no information when
    // a real truncation happens.
    const warn = spyWarn();
    const rows = [
      ...rowsWithIds(20, 'g'),
      UNPARSEABLE_ROW,
    ];

    const result = await runSearch(createMockDocClient([rows]), { mode: 'aggregate' }, { days: 7 });

    expect(result.isPartial).toBe(false);
    expect(result.formatted).toContain('COMPLETE set');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 unparseable row(s)'));
    warn.mockRestore();
  });

  it('flags bulk parse loss, which really does bend the distributions', async () => {
    const warn = spyWarn();
    const rows = [GOOD_ROW, ...Array.from({ length: 5 }, () => UNPARSEABLE_ROW)];

    const result = await runSearch(createMockDocClient([rows]), {}, { days: 7 });

    expect(result.items).toHaveLength(1);
    expect(result.isPartial).toBe(true);
    expect(result.formatted).toContain('could not be parsed');
    warn.mockRestore();
  });

  it('reports one line per cause for the turn, not one per day', async () => {
    // A drift that touches every day of the window is the realistic shape: a
    // migration or producer change does not stop at one partition. Ninety
    // identical CloudWatch lines per chat turn say nothing the first one did.
    const warn = spyWarn();
    const rows = [GOOD_ROW, UNPARSEABLE_ROW];
    const docClient = docClientReturning(rows);

    await runSearch(docClient, {}, { days: 90 });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('dropped 90 unparseable row(s) across 90 day(s)'),
    );
    warn.mockRestore();
  });

  it('puts the warning in the formatted text the model reads, not just the object', async () => {
    // A flag that stays out of `formatted` changes nothing for the user: the
    // model is the only consumer of this tool result.
    const result = await runSearch(createCappedDocClient(true), { limit: 5 }, { days: 30 }, TEST_CAP);

    expect(result.formatted).toContain('INCOMPLETE RESULTS');
    expect(result.formatted).toContain('30-day window');
  });

  it('aggregate mode drops its "COMPLETE set" claim when the scan was truncated', async () => {
    // The dangerous sentence: unqualified, it tells the model to treat capped
    // counts as the whole dataset.
    const result = await runSearch(createCappedDocClient(true), { mode: 'aggregate' }, { days: 90 }, TEST_CAP);

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
    //
    // Counts the notice and the imperative rather than ⚠️ glyphs: an emoji count
    // pins presentation, so dropping the header's glyph while keeping its PARTIAL
    // wording would fail for no behaviour change, and the count only ever held
    // for aggregate mode anyway (list mode has one).
    const result = await runSearch(createCappedDocClient(true), { mode: 'aggregate' }, { days: 90 }, TEST_CAP);

    expectTruncationStatedOnce(result.formatted);
  });

  it('states the truncation once in list mode too', async () => {
    // The aggregate-only assertion above cannot see a list-mode double-append,
    // because list mode never renders the aggregate header.
    const result = await runSearch(createCappedDocClient(true), { limit: 5 }, { days: 90 }, TEST_CAP);

    expectTruncationStatedOnce(result.formatted);
  });

  it('aggregate mode still claims completeness when the whole window was read', async () => {
    const items = rowsWithIds(5, 'a');
    const result = await runSearch(createMockDocClient([items]), { mode: 'aggregate' }, { days: 7 });

    expect(result.isPartial).toBe(false);
    expect(result.formatted).toContain('COMPLETE set');
    expect(result.formatted).not.toContain('PARTIAL');
  });

  it('a feedback-ID hit is complete by construction', async () => {
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const docClient = createMockDocClient([[makeFeedbackItem({ feedback_id: feedbackId })]]);

    const result = await runSearch(docClient, { query: feedbackId }, { days: 7 });

    expect(result.isPartial).toBe(false);
  });

  it('answers about the item when its row will not parse, in one query', async () => {
    // Strict `.parse` threw into the fall-through catch, so a single-key lookup
    // became a 91-query window scan that returned nothing and hedged about a
    // 90-day window the user never asked about. The row exists; that is the answer.
    const warn = spyWarn();
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const docClient = createMockDocClient([
      [{ feedback_id: feedbackId, original_text: 12345 }],
    ]);

    const result = await runSearch(docClient, { query: feedbackId }, { days: 90 });

    expect(queriedIndexes(docClient.send)).toStrictEqual([FEEDBACK_BY_ID_INDEX]);
    expect(result.items).toHaveLength(0);
    expect(result.isPartial).toBe(true);
    expect(proseGaps(result.formatted, {
      has: ['could not be read'],
      lacks: ['90-day window', 'INCOMPLETE RESULTS'],
    })).toStrictEqual(NO_PROSE_GAPS);
    warn.mockRestore();
  });

  it('still falls through to the date scan when the ID index has no such row', async () => {
    const feedbackId = 'abcdef1234567890abcdef1234567890';
    const inWindow = makeFeedbackItem({ feedback_id: 'd'.repeat(32) });
    const docClient = createMockDocClient([[], [inWindow]]);

    const result = await runSearch(docClient, { query: feedbackId }, { days: 7 });

    // The ID query plus the day scan, so a mistyped ID still gets a text search.
    expect(docClient.send).toHaveBeenCalledTimes(8);
    expect(result.isPartial).toBe(false);
  });
});
