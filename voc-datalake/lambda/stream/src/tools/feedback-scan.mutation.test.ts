/**
 * The date scan's accounting, driven directly through `fetchCandidatesByDate`.
 *
 * Every earlier spec reached the scan through `executeSearchFeedback` and read the
 * outcome back out of the prose, which hid what the mutation run found: the
 * operator warnings were never compared verbatim (the systemic suffix, the date
 * lists, the UnknownError name), the dated-days stop could not tell a malformed-only
 * day from an empty one, the budget could charge dropped rows, a second-page failure
 * could erase a day that had answered, the last wave could claim `daysUnread`, and
 * the bulk-loss threshold was never probed at its boundary. Each case below pins the
 * whole result (reasons in order, `unmeasured`, `daysCovered`) and the warning lines.
 */
import { describe, expect, it } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isRecord } from '../lib/is-record.js';
import { FEEDBACK_BY_ID_INDEX } from '../indexes.js';
import {
  feedbackItemSchema,
  fetchCandidatesByDate,
  queryFeedbackById,
  type FeedbackQueryPage,
} from './feedback-scan.js';
import {
  daysAgo,
  fakeDocClient,
  freezeClock,
  makeFeedbackItem,
  queriedDate,
  rowsWithIds,
  spyWarn,
  type FakeDocClient,
} from './feedback-test-fixtures.js';

const TABLE = 'test-feedback-table';
/** Fails `feedbackItemSchema`: the id must be a string. */
const BAD = { feedback_id: 123 };
const VALID = makeFeedbackItem();

type Answer = FeedbackQueryPage | { reject: unknown };

/**
 * Answers each day's page `n` from `pagesByDate[date][n]` (an empty page past the
 * end); a page links to the next through `LastEvaluatedKey: { page: n + 1 }`.
 */
function pagedClient(pagesByDate: Record<string, Answer[]>): FakeDocClient {
  return fakeDocClient((command) => {
    const start: unknown = command.input.ExclusiveStartKey;
    const index = isRecord(start) ? Number(start.page) : 0;
    const answer = pagesByDate[queriedDate(command)]?.[index] ?? { Items: [] };
    return 'reject' in answer ? Promise.reject(answer.reject) : Promise.resolve(answer);
  });
}

/** The scan's result with the candidates reduced to their count. */
async function scan(client: FakeDocClient, days: number, cap = 100, maxDatedDays?: number) {
  const result = await fetchCandidatesByDate(client, TABLE, days, cap, maxDatedDays);
  return { ...result, candidates: result.candidates.length };
}

function throttled(): { reject: Error } {
  return { reject: Object.assign(new Error('slow down'), { name: 'ThrottlingException' }) };
}

describe('feedbackItemSchema', () => {
  it('reads a malformed issue_attributes map as absent, and keeps a well-formed one whole', () => {
    expect([
      feedbackItemSchema.parse({ issue_attributes: { software_version: 5 } }).issue_attributes,
      feedbackItemSchema.parse({ issue_attributes: { software_version: '1.2', milestone: 'x' } }).issue_attributes,
    ]).toStrictEqual([null, { software_version: '1.2', milestone: 'x' }]);
  });
});

describe('queryFeedbackById', () => {
  it('queries the ID index for the normalised id, one row', async () => {
    const client = fakeDocClient(() => Promise.resolve({ Items: [VALID] }));

    await expect(queryFeedbackById(client, TABLE, '  AbC123  ')).resolves.toStrictEqual([VALID]);
    const [command] = client.send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command?.input).toStrictEqual({
      TableName: TABLE,
      IndexName: FEEDBACK_BY_ID_INDEX,
      KeyConditionExpression: 'feedback_id = :fid',
      ExpressionAttributeValues: { ':fid': 'abc123' },
      Limit: 1,
    });
  });

  it('answers [] for a page without Items and null for a failed query', async () => {
    const empty = await queryFeedbackById(fakeDocClient(() => Promise.resolve({})), TABLE, 'a');
    const failed = await queryFeedbackById(fakeDocClient(() => Promise.reject(new Error('down'))), TABLE, 'a');

    expect([empty, failed]).toStrictEqual([[], null]);
  });
});

describe('fetchCandidatesByDate', () => {
  freezeClock();

  it.each([[undefined], [0]])('walks the whole window when maxDatedDays is %s (never stop early)', async (maxDatedDays) => {
    const warn = spyWarn();
    const client = fakeDocClient(() => Promise.resolve({}));

    await expect(scan(client, 10, 100, maxDatedDays)).resolves.toStrictEqual({
      candidates: 0, reasons: [], unmeasured: false, daysCovered: 10,
    });
    expect([client.send.mock.calls.length, warn.mock.calls]).toStrictEqual([10, []]);
    warn.mockRestore();
  });

  it('counts a day of only malformed rows as a day with data for the dated budget', async () => {
    const warn = spyWarn();
    const client = pagedClient({ [daysAgo(0)]: [{ Items: [BAD] }] });

    await expect(scan(client, 20, 100, 1)).resolves.toStrictEqual({
      candidates: 0, reasons: ['rowsDropped'], unmeasured: false, daysCovered: 1,
    });
    warn.mockRestore();
  });

  // Either way one wave of 8 is read; only a window with a wave left over is short of days.
  it.each([
    ['the only wave claims no unread days', 8, []],
    ['an earlier wave reports the rest unread', 9, ['daysUnread']],
  ])('when the budget runs out, %s', async (_label, days, reasons) => {
    const client = fakeDocClient(() => Promise.resolve({ Items: [VALID] }));

    await expect(scan(client, days, 1)).resolves.toStrictEqual({
      candidates: 8, reasons, unmeasured: false, daysCovered: days,
    });
    expect(client.send).toHaveBeenCalledTimes(8);
  });

  it('charges the budget for parsed rows only, and sums the drops of every page', async () => {
    const warn = spyWarn();
    const client = pagedClient({
      [daysAgo(0)]: [
        { Items: [VALID, BAD, BAD], LastEvaluatedKey: { page: 1 } },
        { Items: [VALID, BAD] },
      ],
    });

    await expect(scan(client, 1, 2)).resolves.toStrictEqual({
      candidates: 2, reasons: ['rowsDropped'], unmeasured: false, daysCovered: 1,
    });
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: dropped 3 unparseable row(s) across 1 day(s); repair the rows to make them searchable. Dates: ${daysAgo(0)}`,
    ]]);
    warn.mockRestore();
  });

  it('a failed first page leaves the day unread, and is not a partial read', async () => {
    const warn = spyWarn();

    await expect(scan(pagedClient({ [daysAgo(0)]: [throttled()] }), 1)).resolves.toStrictEqual({
      candidates: 0, reasons: ['dayReadFailed'], unmeasured: true, daysCovered: 1,
    });
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: 1 day partition(s) failed with ThrottlingException; those days are missing from the answer. Unread: ${daysAgo(0)}`,
    ]]);
    warn.mockRestore();
  });

  it('a failed second page keeps the day measured, with its first page', async () => {
    const warn = spyWarn();
    const client = pagedClient({ [daysAgo(0)]: [{ Items: [VALID], LastEvaluatedKey: { page: 1 } }, throttled()] });

    await expect(scan(client, 1)).resolves.toStrictEqual({
      candidates: 1, reasons: ['dayReadFailed'], unmeasured: false, daysCovered: 1,
    });
    warn.mockRestore();
  });

  it('names a non-Error failure UnknownError', async () => {
    const warn = spyWarn();

    await scan(pagedClient({ [daysAgo(0)]: [{ reject: 'socket hang up' }] }), 1);
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: 1 day partition(s) failed with UnknownError; those days are missing from the answer. Unread: ${daysAgo(0)}`,
    ]]);
    warn.mockRestore();
  });

  it('stops after the wave where any one day hit a systemic fault', async () => {
    const warn = spyWarn();
    const denied = Object.assign(new Error('no'), { name: 'AccessDeniedException' });
    const client = pagedClient({ [daysAgo(0)]: [{ reject: denied }] });

    await expect(scan(client, 16)).resolves.toStrictEqual({
      candidates: 0, reasons: ['daysUnread', 'dayReadFailed'], unmeasured: false, daysCovered: 16,
    });
    expect(client.send).toHaveBeenCalledTimes(8);
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: 1 day partition(s) failed with AccessDeniedException — this name fails identically for every partition of the index, so the scan stopped; those days are missing from the answer. Unread: ${daysAgo(0)}`,
    ]]);
    warn.mockRestore();
  });

  it('keeps reading past a transient fault, and reports its days in one line', async () => {
    const warn = spyWarn();
    const client = pagedClient({ [daysAgo(0)]: [throttled()], [daysAgo(1)]: [throttled()] });

    await expect(scan(client, 16)).resolves.toStrictEqual({
      candidates: 0, reasons: ['dayReadFailed'], unmeasured: false, daysCovered: 16,
    });
    expect(client.send).toHaveBeenCalledTimes(16);
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: 2 day partition(s) failed with ThrottlingException; those days are missing from the answer. Unread: ${daysAgo(0)}; ${daysAgo(1)}`,
    ]]);
    warn.mockRestore();
  });
});

describe('dropped rows make the answer a sample only above a tenth of the rows', () => {
  freezeClock();

  it('1 dropped of 10 is exactly a tenth: logged, not a reason', async () => {
    const warn = spyWarn();
    const client = pagedClient({ [daysAgo(0)]: [{ Items: [BAD, ...rowsWithIds(9, 'a')] }] });

    await expect(scan(client, 1)).resolves.toStrictEqual({
      candidates: 9, reasons: [], unmeasured: false, daysCovered: 1,
    });
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: dropped 1 unparseable row(s) across 1 day(s); repair the rows to make them searchable. Dates: ${daysAgo(0)}`,
    ]]);
    warn.mockRestore();
  });

  it('2 dropped of 10 is above it, and the log lists every day', async () => {
    const warn = spyWarn();
    const client = pagedClient({
      [daysAgo(0)]: [{ Items: [BAD, ...rowsWithIds(4, 'a')] }],
      [daysAgo(1)]: [{ Items: [BAD, ...rowsWithIds(4, 'b')] }],
    });

    await expect(scan(client, 2)).resolves.toStrictEqual({
      candidates: 8, reasons: ['rowsDropped'], unmeasured: false, daysCovered: 2,
    });
    expect(warn.mock.calls).toStrictEqual([[
      `search_feedback: dropped 2 unparseable row(s) across 2 day(s); repair the rows to make them searchable. Dates: ${daysAgo(0)}; ${daysAgo(1)}`,
    ]]);
    warn.mockRestore();
  });
});
