/**
 * Shared fixtures of the feedback-scan specs (`search-feedback.test.ts`,
 * `feedback-scan.test.ts`): the frozen clock, the row factory, and the fake
 * DynamoDB document clients each case drives `executeSearchFeedback` with.
 */
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import type { FeedbackQueryClient, FeedbackQueryPage } from './feedback-scan.js';
import { executeSearchFeedback } from './search-feedback.js';
import type { CategoryScope } from './category-scope.js';

/** The read cases are about the read, not access: the caller sees every category. */
export const ALL_CATEGORIES: CategoryScope = {
  all: true, categoriesAll: true, categories: new Set(), sourceRule: 'all', sources: new Set(), sourcesDenied: new Set(),
};

/**
 * The candidate cap the truncation cases inject.
 *
 * Three rows reach the cap-hit branches that MAX_CANDIDATES needed ten thousand
 * zod-parsed fixtures apiece to reach. Kept far below MAX_CANDIDATES, and
 * asserted so, since a TEST_CAP that drifted up to the real value would put the
 * 10k fixtures back without anyone noticing.
 */
export const TEST_CAP = 3;

const FEEDBACK_TABLE = 'test-feedback-table';

export const today = new Date().toISOString().slice(0, 10);

/** YYYY-MM-DD `n` days before today, UTC — the shape the date GSI partitions by. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * The instant the specs freeze the clock at: midday on the date this module
 * loaded rather than a hard-coded calendar day, because `today` and
 * `makeFeedbackItem`'s default `date` are read off the real clock, and a fixed
 * instant elsewhere in the calendar would put every default fixture outside the
 * window. Freezing at all is what stops a run straddling UTC midnight from
 * flipping a `daysAgo` expectation — a once-a-day CI flake that never reproduces.
 */
const PINNED_NOW = new Date(`${today}T12:00:00.000Z`);

/** Freeze the clock at PINNED_NOW for every case of the enclosing describe. */
export function freezeClock(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export type FeedbackRow = Record<string, unknown>;

export function makeFeedbackItem(overrides: FeedbackRow = {}): FeedbackRow {
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

/** `n` distinct rows whose ids are `prefix` zero-padded to the 32-char id width. */
export function rowsWithIds(n: number, prefix: string): FeedbackRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeFeedbackItem({ feedback_id: `${prefix}${String(i).padStart(32 - prefix.length, '0')}` }));
}

/** The one argument shape every fake `send` sees: a Query command's input. */
export interface QueryCommandLike {
  input: Record<string, unknown>;
}

type FakeSend = (command: QueryCommandLike) => Promise<FeedbackQueryPage>;

export interface FakeDocClient extends FeedbackQueryClient {
  send: Mock<FakeSend>;
}

/**
 * A document client whose `send` is the given implementation. A `QueryCommand`
 * is a `QueryCommandLike`, so the double satisfies `FeedbackQueryClient` as is.
 */
export function fakeDocClient(send: FakeSend): FakeDocClient {
  return { send: vi.fn(send) };
}

/** Answers each call with the next page of `queryResponses`, then empty pages. */
export function createMockDocClient(queryResponses: FeedbackRow[][] = []): FakeDocClient {
  const calls = { count: 0 };
  return fakeDocClient(() => {
    const items = calls.count < queryResponses.length ? queryResponses[calls.count] : [];
    calls.count += 1;
    return Promise.resolve({ Items: items });
  });
}

/** Answers every call with the same page. */
export function docClientReturning(rows: FeedbackRow[]): FakeDocClient {
  return fakeDocClient(() => Promise.resolve({ Items: rows }));
}

/** Fails every call with `error` (whose `name` is what the scan classifies on). */
export function docClientRejecting(error: Error): FakeDocClient {
  async function rejectWith(): Promise<FeedbackQueryPage> {
    throw error;
  }
  return fakeDocClient(rejectWith);
}

/** The YYYY-MM-DD a Query command addresses, read out of its `:pk = DATE#…` value. */
export function queriedDate(command: QueryCommandLike): string {
  const values: unknown = command.input.ExpressionAttributeValues;
  const pk: unknown = typeof values === 'object' && values !== null ? Reflect.get(values, ':pk') : undefined;
  return typeof pk === 'string' ? pk.replace('DATE#', '') : '';
}

/** Answers each day's query from `itemsByDate`, recording the order days were asked for. */
export function createDateAwareDocClient(itemsByDate: Record<string, FeedbackRow[]>): { client: FakeDocClient; queriedDates: string[] } {
  const queriedDates: string[] = [];
  const client = fakeDocClient((command) => {
    const date = queriedDate(command);
    queriedDates.push(date);
    return Promise.resolve({ Items: itemsByDate[date] ?? [] });
  });
  return { client, queriedDates };
}

type ContextFilters = Parameters<typeof executeSearchFeedback>[3];

/**
 * `executeSearchFeedback` against the fixture table — the call every case makes.
 * `scope` defaults to every category; the access cases (search-feedback-scope.test.ts) pass their own.
 */
export function runSearch(
  client: FeedbackQueryClient,
  toolInput: unknown,
  contextFilters: Omit<ContextFilters, 'scope'> & Partial<Pick<ContextFilters, 'scope'>>,
  candidateCap?: number,
): ReturnType<typeof executeSearchFeedback> {
  const filters: ContextFilters = { scope: ALL_CATEGORIES, ...contextFilters };
  return candidateCap === undefined
    ? executeSearchFeedback(client, FEEDBACK_TABLE, toolInput, filters)
    : executeSearchFeedback(client, FEEDBACK_TABLE, toolInput, filters, candidateCap);
}

/** A silenced `console.warn` spy; callers `mockRestore()` it when done. */
export function spyWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/**
 * The prose checks of one formatted answer as one comparable value: the `has`
 * fragments `text` lacks and the `lacks` fragments it contains. A correct answer
 * is `{ missing: [], present: [] }`, and a failure names every wrong fragment at once.
 */
export function proseGaps(
  text: string,
  expected: { has?: readonly string[]; lacks?: readonly string[] },
): { missing: string[]; present: string[] } {
  return {
    missing: (expected.has ?? []).filter((fragment) => !text.includes(fragment)),
    present: (expected.lacks ?? []).filter((fragment) => text.includes(fragment)),
  };
}

export const NO_PROSE_GAPS = { missing: [], present: [] };

/** The IndexName of every query a fake `send` received, in order (undefined for a table query). */
export function queriedIndexes(send: { mock: { calls: ReadonlyArray<readonly [{ input: object }, ...unknown[]]> } }): unknown[] {
  return send.mock.calls.map(([command]): unknown => Reflect.get(command.input, 'IndexName'));
}
