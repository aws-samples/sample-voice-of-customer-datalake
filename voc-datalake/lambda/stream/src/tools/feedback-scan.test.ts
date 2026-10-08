/**
 * Tests for the feedback date scan: how wide it fans out, and in what order.
 *
 * Separate from search-feedback.test.ts along the same seam as the source split.
 * These assert properties of the READ — the fan-out width, date ordering under
 * concurrency, and the shared candidate budget — rather than anything about the
 * prose the tool returns, and they are the tests a change to the scan shape must
 * be run against.
 */
import { describe, it, expect } from 'vitest';
import { DAY_SCAN_CONCURRENCY, MAX_CANDIDATES, type FeedbackQueryPage } from './feedback-scan.js';
import {
  TEST_CAP,
  daysAgo,
  docClientReturning,
  fakeDocClient,
  freezeClock,
  makeFeedbackItem,
  queriedDate,
  rowsWithIds,
  runSearch,
} from './feedback-test-fixtures.js';

/**
 * How many rows the scan actually collected, read out of aggregate mode's own total.
 *
 * The collected count has no field on the result — `items` is the capped example set —
 * so the prose is the only channel that reports it. Aggregate mode over unfiltered
 * fixtures matches every candidate, which makes its total equal to the collection.
 */
const totalMatches = (formatted: string): number =>
  Number(/\*\*Total matches:\*\* (\d+)/.exec(formatted)?.[1] ?? NaN);

describe('the day scan is bounded-concurrent, not sequential', () => {
  freezeClock();

  it('drives the cap branches with an injected budget, not the production one', () => {
    // The override is what lets the truncation cases in search-feedback.test.ts
    // use 3-row fixtures
    // instead of 10 000 each. If TEST_CAP ever drifted up to the real value the
    // fixtures would silently balloon again; if MAX_CANDIDATES drifted down to a
    // handful, production would report truncation on ordinary windows.
    expect(TEST_CAP).toBeLessThan(MAX_CANDIDATES);
    expect(MAX_CANDIDATES).toBe(10000);
  });

  /** Counts how many sends are in flight at once, so overlap is observable. */
  function createOverlapTrackingDocClient() {
    const inFlight = { now: 0, max: 0 };
    const client = fakeDocClient(() => {
        inFlight.now += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        return Promise.resolve({ Items: [] }).finally(() => {
          inFlight.now -= 1;
        });
      });
    return { client, inFlight };
  }

  it('overlaps day reads in waves instead of awaiting one at a time', async () => {
    // 90 sequential round trips sat in front of a half-rendered chat turn. At a
    // 12ms round trip that measured p99 1092ms sequential against 153ms in waves
    // of 8 — less even than the 30-day sequential scan this widening replaced.
    const { client, inFlight } = createOverlapTrackingDocClient();

    await runSearch(client, {}, { days: 90 });

    // Both assertions carry weight and neither suffices alone. The first catches
    // a return to sequential reads; comparing only against the imported constant
    // would NOT, because setting it to 1 satisfies the equality — a green result
    // meaning "did not check". The second catches an unbounded fan-out, or drift
    // from the declared width.
    expect(inFlight.max).toBeGreaterThan(1);
    expect(inFlight.max).toBe(DAY_SCAN_CONCURRENCY);
    expect(client.send).toHaveBeenCalledTimes(90);
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
    const client = fakeDocClient((command) => {
        const date = queriedDate(command);
        const items = byDate[date] ?? [];
        // Newer days settle LAST: each awaits more microtask turns than the day
        // before it, so completion order is the reverse of date order. Microtasks
        // rather than timers because these tests run on fake timers.
        const settleOrder: Record<string, number> = { [daysAgo(1)]: 3, [daysAgo(2)]: 2 };
        const turns = settleOrder[date] ?? 1;
        return Array.from({ length: turns }).reduce<Promise<FeedbackQueryPage>>(
          (p) => p.then((v) => v),
          Promise.resolve({ Items: items }),
        );
      });

    const result = await runSearch(client, {}, { days: 5 });

    expect(result.items.map((i) => i.date)).toStrictEqual([daysAgo(1), daysAgo(2), daysAgo(3)]);
  });

  it('honours the shared candidate budget across concurrent days, not per day', async () => {
    // The reason concurrency is safe here at all. A per-day slice of the budget
    // would let each in-flight day spend the whole remainder — 8 x the cap held
    // at once, which is exactly what the cap exists to prevent. One counter,
    // charged as pages land, so the total is bounded however wide the fan-out.
    const rows = rowsWithIds(4, 'd');
    // Fixture invariant, asserted before the act rather than trailing the outcomes: one
    // page has to outspend the cap on its own, or the budget branches below are never
    // reached and this case passes without exercising the property it is named for.
    expect(rows.length).toBeGreaterThan(TEST_CAP);
    const client = docClientReturning(rows);

    const result = await runSearch(
      client, { mode: 'aggregate' }, { days: 90 }, TEST_CAP,
    );

    // One wave of 8 days x 4 rows is all that may be collected: the budget is
    // gone, so wave 2 is never dispatched. Per-day budgeting would keep going.
    expect({ dayReads: client.send.mock.calls.length, isPartial: result.isPartial })
      .toStrictEqual({ dayReads: DAY_SCAN_CONCURRENCY, isPartial: true });
    // And the total actually collected, which is the property this case is named for and
    // previously went unchecked — the two assertions above pass for a per-day budget too.
    //
    // Bounded, not pinned. The ceiling is the cap plus one wave of pages, because a page
    // charges the budget only after it lands and a wave dispatches before any of them do
    // (see CandidateBudget). Asserting the exact overshoot would freeze slack the source
    // deliberately leaves open: charging before dispatch is a correction that docblock
    // contemplates, and an equality here would fail it as though it were a defect. The
    // ceiling still rules out the per-day slice this case exists to reject — that design
    // budgets each day separately, so the scan runs every wave and collects an order of
    // magnitude more than this.
    // The ceiling is the discriminating assertion and the only one that may name the
    // cap: any correct shared budget lands under it, whether it charges as pages land
    // (today, so up to a wave over) or reserves before dispatch (a correction, landing
    // AT the cap). A lower bound of `> TEST_CAP` would forbid that second one, which is
    // the mistake the equality here made in the first place. `> 0` guards vacuity only —
    // an empty read would otherwise satisfy the ceiling and prove nothing.
    const collected = totalMatches(result.formatted);
    expect(collected).toBeLessThanOrEqual(TEST_CAP + DAY_SCAN_CONCURRENCY * rows.length);
    expect(collected).toBeGreaterThan(0);
  });
});
