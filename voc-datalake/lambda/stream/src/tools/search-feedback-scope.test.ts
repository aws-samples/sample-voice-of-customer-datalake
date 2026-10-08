/**
 * search_feedback: the caller's category scope and the all-time window.
 *
 * Split from search-feedback.test.ts (max-lines). The helpers here are a single
 * date-keyed fake rather than copies of that file's call-order mocks.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { executeSearchFeedback } from './search-feedback.js';
import { DAY_SCAN_CONCURRENCY, MAX_LOOKBACK_DAYS, MAX_SAMPLE_WALK_DAYS } from './feedback-scan.js';
import type { CategoryScope } from './category-scope.js';
import { FEEDBACK_BY_ID_INDEX } from '../indexes.js';
import { ALL_CATEGORIES, queriedIndexes } from './feedback-test-fixtures.js';

const TABLE = 'test-feedback-table';
const DELIVERY_ONLY: CategoryScope = { ...ALL_CATEGORIES, all: false, categoriesAll: false, categories: new Set(['delivery']) };
/** Every category, but the restricted `support_tickets` source hidden (no explicit grant). */
const NO_TICKETS: CategoryScope = { ...ALL_CATEGORIES, all: false, sourceRule: 'deny', sourcesDenied: new Set(['support_tickets']) };
const FEEDBACK_ID = 'abcdef1234567890abcdef1234567890';
const TODAY = new Date().toISOString().slice(0, 10);

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feedback_id: id.padEnd(32, '0'),
    source_platform: 'webscraper',
    sentiment_label: 'negative',
    category: 'delivery',
    original_text: `Text ${id}`,
    date: TODAY,
    urgency: 'high',
    ...overrides,
  };
}

/** Answers every query from `rows`: the ID index and each day partition alike; records each query's pk. */
function fakeTable(rows: Record<string, unknown>[]) {
  const pks: unknown[] = [];
  const send = vi.fn((command: { input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
    pks.push(command.input.ExpressionAttributeValues?.[':pk']);
    return Promise.resolve({ Items: rows });
  });
  // The tool only calls `send`; this narrow fake stands in for the whole client.
  const client: Pick<DynamoDBDocumentClient, 'send'> = { send };
  return { client: client as DynamoDBDocumentClient, send, pks };
}

describe('category scope', () => {
  const ROWS = [
    row('a'),
    row('b', { category: 'billing', original_text: 'Charged twice' }),
    row('c', { category: undefined, original_text: 'Legacy row' }),
  ];

  it('hides items outside the scope from lists, including uncategorised rows', async () => {
    const { client } = fakeTable(ROWS);
    const result = await executeSearchFeedback(client, TABLE, {}, { scope: DELIVERY_ONLY, days: 1 });
    expect(result.items.map((item) => item.category)).toStrictEqual(['delivery']);
    expect(result.formatted).not.toContain('Charged twice');
    expect(result.formatted).not.toContain('Legacy row');
  });

  it('counts only in-scope items in aggregate mode', async () => {
    const { client } = fakeTable(ROWS);
    const result = await executeSearchFeedback(client, TABLE, { mode: 'aggregate' }, { scope: DELIVERY_ONLY, days: 1 });
    expect(result.formatted).toContain('**Total matches:** 1');
    expect(result.formatted).not.toContain('billing');
  });

  it('answers a direct ID lookup outside the scope as "not found", in one query', async () => {
    const { client, send } = fakeTable([row('x', { feedback_id: FEEDBACK_ID, category: 'billing' })]);
    const result = await executeSearchFeedback(client, TABLE, { query: FEEDBACK_ID }, { scope: DELIVERY_ONLY, days: 7 });
    expect(queriedIndexes(send)).toStrictEqual([FEEDBACK_BY_ID_INDEX]);
    expect(result.items).toHaveLength(0);
    expect(result.formatted).toBe('No feedback found matching the search criteria.');
  });

  it('does not tell a restricted caller that an unreadable row exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeTable([{ feedback_id: FEEDBACK_ID, original_text: 12_345 }]);
    const result = await executeSearchFeedback(client, TABLE, { query: FEEDBACK_ID }, { scope: DELIVERY_ONLY, days: 7 });
    expect(result.formatted).not.toContain('could not be read');
    warn.mockRestore();
  });
});

describe('source scope', () => {
  const ROWS = [
    row('a'),
    row('t', { source_platform: 'support_tickets', original_text: 'Ticket about my IBAN' }),
  ];

  it('hides a restricted-source item from lists', async () => {
    const { client } = fakeTable(ROWS);
    const result = await executeSearchFeedback(client, TABLE, {}, { scope: NO_TICKETS, days: 1 });
    expect(result.items.map((item) => item.source_platform)).toStrictEqual(['webscraper']);
    expect(result.formatted).not.toContain('Ticket about my IBAN');
  });

  it('leaves a restricted-source item out of aggregate counts', async () => {
    const { client } = fakeTable(ROWS);
    const result = await executeSearchFeedback(client, TABLE, { mode: 'aggregate' }, { scope: NO_TICKETS, days: 1 });
    expect(result.formatted).toContain('**Total matches:** 1');
    expect(result.formatted).not.toContain('support_tickets');
  });

  it('answers a by-id lookup of a restricted-source item as "not found"', async () => {
    const { client } = fakeTable([row('x', { feedback_id: FEEDBACK_ID, source_platform: 'support_tickets' })]);
    const result = await executeSearchFeedback(client, TABLE, { query: FEEDBACK_ID }, { scope: NO_TICKETS, days: 7 });
    expect(result.items).toHaveLength(0);
    expect(result.formatted).toBe('No feedback found matching the search criteria.');
  });

  it('admits nothing under a restricted rule it cannot name (fail closed)', async () => {
    const { client } = fakeTable(ROWS);
    const scope: CategoryScope = { ...ALL_CATEGORIES, all: false, sourceRule: 'none' };
    const result = await executeSearchFeedback(client, TABLE, {}, { scope, days: 1 });
    expect(result.items).toStrictEqual([]);
  });
});

describe('all-time window (days = 0)', () => {
  it('walks MAX_SAMPLE_WALK_DAYS over an empty table and says the answer does not cover all time', async () => {
    const { client, pks } = fakeTable([]);
    const result = await executeSearchFeedback(client, TABLE, { mode: 'aggregate' }, { scope: ALL_CATEGORIES, days: 0 });
    expect(pks).toHaveLength(MAX_SAMPLE_WALK_DAYS);
    expect(result.isPartial).toBe(true);
  });

  it('stops after MAX_LOOKBACK_DAYS days that returned feedback', async () => {
    const { client, pks } = fakeTable([row('a')]);
    const result = await executeSearchFeedback(client, TABLE, { mode: 'aggregate' }, { scope: ALL_CATEGORIES, days: 0 });
    // Kept: exactly the first 90 dated days. Read: whole waves, so up to one wave more.
    expect(result.formatted).toContain(`**Total matches:** ${MAX_LOOKBACK_DAYS}`);
    expect(pks).toHaveLength(Math.ceil(MAX_LOOKBACK_DAYS / DAY_SCAN_CONCURRENCY) * DAY_SCAN_CONCURRENCY);
  });

  it('names all time, not a negative day count, in the notice', async () => {
    const { client } = fakeTable([row('a')]);
    const result = await executeSearchFeedback(client, TABLE, {}, { scope: ALL_CATEGORIES, days: 0 });
    expect(result.formatted).toContain('the question named all time');
    expect(result.formatted).toContain('say nothing about anything older');
    expect(result.formatted).not.toMatch(/-\d+ earlier days/);
  });
});
