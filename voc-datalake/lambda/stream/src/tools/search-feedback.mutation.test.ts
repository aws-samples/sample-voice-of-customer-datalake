/**
 * search_feedback: the exact prose and orderings the model reads.
 *
 * The mutation run of search-feedback.ts found that the earlier specs checked
 * fragments (`toContain('Found 1')`, `every(...)`, `length <= 30`), so a blanked
 * line of the item block, an unsorted distribution, a wrong percentage, a dropped
 * truncation clause or a tie-break that never ran all passed. These cases pin the
 * whole formatted answer, both sides of every filter, and each sort key alone.
 */
import { describe, it, expect } from 'vitest';
import { FEEDBACK_BY_ID_INDEX } from '../indexes.js';
import type { CategoryScope } from './category-scope.js';
import {
  ALL_CATEGORIES,
  createMockDocClient,
  daysAgo,
  docClientRejecting,
  fakeDocClient,
  type FeedbackRow,
  freezeClock,
  makeFeedbackItem,
  queriedDate,
  queriedIndexes,
  rowsWithIds,
  runSearch,
  spyWarn,
  today,
} from './feedback-test-fixtures.js';

freezeClock();

const HEX_ID = 'abcdef1234567890abcdef1234567890';
const NO_MATCH = 'No feedback found matching the search criteria.';

/** Rows answered by the first (day-0) query; every later partition is empty. */
async function search(rows: FeedbackRow[], toolInput: unknown, filters: Parameters<typeof runSearch>[2] = { days: 7 }) {
  return runSearch(createMockDocClient([rows]), toolInput, filters);
}

async function ids(rows: FeedbackRow[], toolInput: unknown, filters?: Parameters<typeof runSearch>[2]) {
  return (await search(rows, toolInput, filters)).items.map((item) => item.feedback_id);
}

interface Block {
  source: string; date: string; sentiment: string; score: string; category: string;
  rating: string; text: string; problem?: string;
}

/** The item block as the model reads it, written out field by field. */
function block(n: number, b: Block): string {
  const problemLine = b.problem === undefined ? '' : `- Problem Summary: ${b.problem}`;
  return `### Feedback #${n}\n- Source: ${b.source}\n- Date: ${b.date}\n- Sentiment: ${b.sentiment} (${b.score})\n`
    + `- Category: ${b.category}\n- Rating: ${b.rating}\n- Text: "${b.text}"\n${problemLine}\n\n`;
}

const DEFAULT_BLOCK: Block = {
  source: 'webscraper', date: today, sentiment: 'negative', score: '-0.80', category: 'delivery',
  rating: '2', text: 'My package arrived late and damaged', problem: 'Package delayed and damaged',
};

describe('list formatting', () => {
  it('renders every field of an item, numbered from 1, with no notice on a complete scan', async () => {
    const result = await search([makeFeedbackItem()], {});
    expect(result).toStrictEqual({
      items: [expect.objectContaining({ feedback_id: 'abc123def456abc123def456abc12345' })],
      formatted: `Found 1 relevant feedback items:\n\n${block(1, DEFAULT_BLOCK)}`,
      isPartial: false,
    });
  });

  it('renders the placeholders of a sparse row and cuts the text at 400 characters', async () => {
    const sparse = { feedback_id: 's'.repeat(32), date: today, original_text: `${'x'.repeat(400)}TAIL`, rating: null };
    const result = await search([makeFeedbackItem(), sparse], {});
    expect(result.formatted).toBe(`Found 2 relevant feedback items:\n\n${block(1, DEFAULT_BLOCK)}${block(2, {
      source: 'unknown', date: 'N/A', sentiment: 'unknown', score: '0.00', category: 'other',
      rating: 'N/A', text: 'x'.repeat(400),
    })}`);
  });

  it('answers an empty match with the no-match sentence alone', async () => {
    expect((await search([makeFeedbackItem()], { query: 'nothing like this' })).formatted).toBe(NO_MATCH);
  });
});

describe('aggregate formatting', () => {
  const ROWS = [
    makeFeedbackItem({ feedback_id: 'b', urgency: 'low', sentiment_label: 'positive', category: 'billing', source_platform: 'manual_import', rating: '5', sentiment_score: 0.5 }),
    makeFeedbackItem({ feedback_id: 'a', sentiment_score: -0.9 }),
    makeFeedbackItem({ feedback_id: 'c', rating: null }),
    makeFeedbackItem({ feedback_id: 'd', urgency: undefined, sentiment_label: 'neutral', rating: undefined, sentiment_score: 0 }),
  ];

  it('states totals, the average of the numeric ratings and count-sorted distributions', async () => {
    const result = await search(ROWS, { mode: 'aggregate', limit: 1 });
    expect(result.items.map((item) => item.feedback_id)).toStrictEqual(['a']);
    expect(result.formatted).toBe(
      'Aggregate summary over ALL 4 matching feedback items '
      + '(this is the COMPLETE set, not a sample — base your answer on these numbers):\n\n'
      + '**Total matches:** 4\n**Average rating:** 3.50\n\n'
      + '**By urgency:**\n- high: 2 (50%)\n- low: 1 (25%)\n- unknown: 1 (25%)\n\n'
      + '**By sentiment:**\n- negative: 2 (50%)\n- positive: 1 (25%)\n- neutral: 1 (25%)\n\n'
      + '**By category:**\n- delivery: 3 (75%)\n- billing: 1 (25%)\n\n'
      + '**By source:**\n- webscraper: 3 (75%)\n- manual_import: 1 (25%)\n\n'
      + '**Top 1 examples (most urgent first):**\n\n'
      + block(1, { ...DEFAULT_BLOCK, score: '-0.90' }),
    );
  });

  it('says N/A when no row has a numeric rating, and lists no examples at limit 0', async () => {
    const result = await search([makeFeedbackItem({ rating: null })], { mode: 'aggregate', limit: 0 });
    expect(result.items).toStrictEqual([]);
    expect(result.formatted).toBe(
      'Aggregate summary over ALL 1 matching feedback items '
      + '(this is the COMPLETE set, not a sample — base your answer on these numbers):\n\n'
      + '**Total matches:** 1\n**Average rating:** N/A\n\n'
      + '**By urgency:**\n- high: 1 (100%)\n\n**By sentiment:**\n- negative: 1 (100%)\n\n'
      + '**By category:**\n- delivery: 1 (100%)\n\n**By source:**\n- webscraper: 1 (100%)\n\n',
    );
  });

  it('lists only the ten largest categories', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => makeFeedbackItem({ feedback_id: `k${i}`, category: `c${i}` }));
    const { formatted } = await search(rows, { mode: 'aggregate', limit: 0 });
    const categories = Array.from({ length: 10 }, (_, i) => `- c${i}: 1 (9%)`).join('\n');
    expect(formatted).toContain(`**By category:**\n${categories}\n\n**By source:**`);
  });

  it('labels a truncated aggregate PARTIAL and drops the ALL claim', async () => {
    const page = rowsWithIds(3, 'c');
    const client = fakeDocClient(() => Promise.resolve({ Items: page, LastEvaluatedKey: { k: 'next' } }));
    const { formatted } = await runSearch(client, { mode: 'aggregate', limit: 0 }, { days: 1 }, 3);
    expect(formatted.startsWith(
      'Aggregate summary over 3 matching feedback items (⚠️ PARTIAL — a sample of the window, NOT the '
      + 'complete set; see the note below these figures):\n\n**Total matches:** 3 (partial — scan truncated)\n',
    )).toBe(true);
  });
});

describe('truncation notices, word for word', () => {
  const SAY_SO = 'Say so when you answer';

  /** Every partition empty except `failDay`, which throws a transient error. */
  function oneDayFails(failDay: number) {
    return fakeDocClient((command) => (queriedDate(command) === daysAgo(failDay)
      ? Promise.reject(Object.assign(new RangeError('t'), { name: 'ProvisionedThroughputExceededException' }))
      : Promise.resolve({ Items: [] })));
  }

  it('names part of the scanned window for one cause', async () => {
    const warn = spyWarn();
    const { formatted } = await runSearch(oneDayFails(3), {}, { days: 7 });
    expect(formatted).toBe(`${NO_MATCH}\n⚠️ INCOMPLETE RESULTS: the items and any counts above cover part of the 7-day window `
      + `— at least one day could not be read. ${SAY_SO}, name the 7-day window they do cover, `
      + 'and do not present these totals or percentages as complete.\n');
    warn.mockRestore();
  });

  it.each([
    [500, 'the 500-day window'],
    [0, 'the all-time window'],
  ])('joins the clamp and a failed day, naming the requested window (days=%i)', async (days, noun) => {
    const warn = spyWarn();
    const { formatted } = await runSearch(oneDayFails(3), {}, { days });
    expect(formatted).toBe(`${NO_MATCH}\n⚠️ INCOMPLETE RESULTS: the items and any counts above cover only the most recent `
      + `400 days of ${noun} asked about — the requested window is longer than this search can reach; `
      + `at least one day could not be read. ${SAY_SO}, name the 400-day window they do cover, `
      + 'and do not present these totals or percentages as complete.\n');
    warn.mockRestore();
  });

  it('says a clamped but fully read window is complete for the days it covers', async () => {
    const { formatted } = await search([makeFeedbackItem()], {}, { days: 500 });
    expect(formatted).toBe(`Found 1 relevant feedback items:\n\n${block(1, DEFAULT_BLOCK)}`
      + '\n⚠️ NARROWER WINDOW THAN ASKED ABOUT: this search reaches back at most 400 days, but the question '
      + 'named 500 days. The figures above are complete for the most recent 400 days and say nothing about '
      + 'the 100 earlier days. Name the 400-day window when you answer, and do not describe these numbers '
      + 'as covering the longer period.\n');
  });

  it('tells the model the window is unmeasured when no day could be read', async () => {
    const warn = spyWarn();
    const client = docClientRejecting(Object.assign(new RangeError('d'), { name: 'AccessDeniedException' }));
    const result = await runSearch(client, {}, { days: 30 });
    expect(result).toStrictEqual({
      items: [],
      formatted: '⚠️ THE SEARCH COULD NOT BE RUN: no day of the 30-day window could be read, so nothing is known '
        + 'about it. This is NOT a result of zero feedback items. Tell the user the feedback store could not be '
        + 'reached and that you therefore cannot answer, and do not state or imply any count — including zero.\n',
      isPartial: true,
    });
    warn.mockRestore();
  });
});

describe('input parsing', () => {
  const THREE = rowsWithIds(3, 'p');

  it.each([
    [{ mode: 'list', limit: 1 }, 1],
    [{ sort_by: 'recent', limit: 1 }, 1],
    // A malformed field fails the whole parse, so the default limit applies, not '2'.
    [{ limit: '2' }, 3],
  ])('%j returns %i item(s)', async (input, count) => {
    expect((await search(THREE, input)).items).toHaveLength(count);
  });

  it('defaults the list to 15 items and caps it at 30', async () => {
    const rows = rowsWithIds(40, 'n');
    expect((await search(rows, {})).items).toHaveLength(15);
    expect((await search(rows, { limit: 100 })).items).toHaveLength(30);
  });

  it('prefers the tool input category over the page context', async () => {
    const rows = [makeFeedbackItem({ feedback_id: 'del' }), makeFeedbackItem({ feedback_id: 'bil', category: 'billing' })];
    expect(await ids(rows, { category: 'billing' }, { days: 7, category: 'delivery' })).toStrictEqual(['bil']);
    expect(await ids(rows, {}, { days: 7, category: 'delivery' })).toStrictEqual(['del']);
  });
});

describe('filters admit the match and nothing else', () => {
  it.each([
    [{ source: 'manual_import' }, { source_platform: 'manual_import' }],
    [{ category: 'billing' }, { category: 'billing' }],
    [{ urgency: 'low' }, { urgency: 'low' }],
    [{ version: '2.0-preview' }, { issue_attributes: { software_version: '2.0-preview' } }],
    [{ tag: 'vip' }, { tags: ['other', 'VIP'] }],
  ])('%j', async (input, hitFields) => {
    const rows = [
      makeFeedbackItem({ feedback_id: 'miss', tags: ['other'], issue_attributes: { software_version: '1.0' } }),
      makeFeedbackItem({ feedback_id: 'hit', ...hitFields }),
    ];
    expect(await ids(rows, input)).toStrictEqual(['hit']);
  });

  it('treats a row without tags or dimensions as matching no tag or dimension', async () => {
    const bare = makeFeedbackItem({ feedback_id: 'bare' });
    expect(await ids([bare], { tag: 'stryker was here' })).toStrictEqual([]);
    expect(await ids([bare], { dims: { product: 'app' } })).toStrictEqual([]);
  });

  it.each([
    ['ARRIVED', 'the text'],
    ['DELAYED', 'the problem summary'],
  ])('matches %s case-insensitively in %s alone', async (query) => {
    expect(await ids([makeFeedbackItem({ feedback_id: 'hit' })], { query })).toStrictEqual(['hit']);
  });

  it('matches nothing in fields a row does not have', async () => {
    const empty = makeFeedbackItem({ original_text: undefined, title: undefined, problem_summary: undefined });
    expect(await ids([empty], { query: 'stryker' })).toStrictEqual([]);
  });
});

describe('the date the window applies to', () => {
  const old = daysAgo(400);

  it.each([
    ['an absent import date', { date: undefined }, undefined],
    ['a malformed review date', { date: old, source_created_at: 'unavailable' }, 'review' as const],
    ['a review date not at the start of the value', { date: old, source_created_at: `note ${today}` }, 'review' as const],
    // One digit short of a day: sorts above the cutoff if the shape check let it through.
    ['a review date with a one-digit day', { date: old, source_created_at: `${today.slice(0, 9)}Z` }, 'review' as const],
  ])('excludes a row with %s', async (_label, fields, dateBasis) => {
    expect(await ids([makeFeedbackItem(fields)], {}, { days: 7, dateBasis })).toStrictEqual([]);
  });
});

describe('sort_by urgency tie-breaks', () => {
  it('orders one tier by sentiment, an absent score counting as 0', async () => {
    const rows = [
      makeFeedbackItem({ feedback_id: 'm02', sentiment_score: -0.2 }),
      makeFeedbackItem({ feedback_id: 'p05', sentiment_score: 0.5 }),
      makeFeedbackItem({ feedback_id: 'none', sentiment_score: undefined }),
      makeFeedbackItem({ feedback_id: 'm09', sentiment_score: -0.9 }),
    ];
    expect(await ids(rows, { sort_by: 'urgency' })).toStrictEqual(['m09', 'm02', 'none', 'p05']);
  });

  it('then by date, newest first and an undated row last', async () => {
    const rows = [
      makeFeedbackItem({ feedback_id: 'older', date: daysAgo(2) }),
      makeFeedbackItem({ feedback_id: 'undated', date: undefined }),
      makeFeedbackItem({ feedback_id: 'newest', date: today }),
    ];
    const order = await ids(rows, { sort_by: 'urgency' }, { days: 7, dateBasis: 'review' });
    expect(order).toStrictEqual(['newest', 'older', 'undated']);
  });

  it('applies the same order to the aggregate examples', async () => {
    const rows = [makeFeedbackItem({ feedback_id: 'low', urgency: 'low' }), makeFeedbackItem({ feedback_id: 'high' })];
    expect(await ids(rows, { mode: 'aggregate' })).toStrictEqual(['high', 'low']);
  });

  it('ranks low above an absent urgency', async () => {
    const rows = [makeFeedbackItem({ feedback_id: 'none', urgency: undefined }), makeFeedbackItem({ feedback_id: 'low', urgency: 'low' })];
    expect(await ids(rows, { sort_by: 'urgency' })).toStrictEqual(['low', 'none']);
  });

  it('writes the example blocks back to back', async () => {
    const rows = [makeFeedbackItem({ feedback_id: 'one' }), makeFeedbackItem({ feedback_id: 'two', original_text: undefined })];
    const { formatted } = await search(rows, { mode: 'aggregate' });
    expect(formatted.endsWith(`**Top 2 examples (most urgent first):**\n\n${block(1, DEFAULT_BLOCK)}${block(2, { ...DEFAULT_BLOCK, text: '' })}`))
      .toBe(true);
  });
});

describe('feedback-ID lookup', () => {
  const DELIVERY_ONLY: CategoryScope = { ...ALL_CATEGORIES, all: false, categoriesAll: false, categories: new Set(['delivery']) };

  it.each([`x${HEX_ID}`, `${HEX_ID}x`])('treats %s as text, not an ID', async (query) => {
    const client = createMockDocClient();
    await runSearch(client, { query }, { days: 1 });
    expect(queriedIndexes(client.send)).not.toContain(FEEDBACK_BY_ID_INDEX);
  });

  it('trims the query before deciding it is an ID', async () => {
    const client = createMockDocClient([[makeFeedbackItem({ feedback_id: HEX_ID })]]);
    const result = await runSearch(client, { query: `  ${HEX_ID.toUpperCase()}  ` }, { days: 7 });
    expect(queriedIndexes(client.send)).toStrictEqual([FEEDBACK_BY_ID_INDEX]);
    expect(result).toStrictEqual({
      items: [expect.objectContaining({ feedback_id: HEX_ID })],
      formatted: `Found 1 relevant feedback items:\n\n${block(1, DEFAULT_BLOCK)}`,
      isPartial: false,
    });
  });

  it('shows a restricted caller an in-scope hit', async () => {
    const client = createMockDocClient([[makeFeedbackItem({ feedback_id: HEX_ID })]]);
    const result = await runSearch(client, { query: HEX_ID }, { days: 7, scope: DELIVERY_ONLY });
    expect(result.items.map((item) => item.feedback_id)).toStrictEqual([HEX_ID]);
    expect(result.isPartial).toBe(false);
  });

  it('falls through to the date scan when the ID query fails', async () => {
    let call = 0;
    const client = fakeDocClient(() => {
      call += 1;
      return call === 1 ? Promise.reject(new RangeError('boom')) : Promise.resolve({ Items: [makeFeedbackItem({ feedback_id: 'day' })] });
    });
    const result = await runSearch(client, { query: HEX_ID }, { days: 1 });
    expect(result.items).toStrictEqual([]);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('says the item exists but could not be read, and logs which', async () => {
    const warn = spyWarn();
    const result = await search([{ feedback_id: HEX_ID, original_text: 12345 }], { query: HEX_ID });
    expect(result).toStrictEqual({
      items: [],
      formatted: 'The requested feedback item exists but its stored row could not be read, so its details are '
        + 'unavailable. Say that the item could not be read — do NOT say no such item exists, and do not present '
        + 'other feedback as if it were this item.\n',
      isPartial: true,
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(`search_feedback: feedback_id ${HEX_ID} matched a row that would not parse`);
    warn.mockRestore();
  });
});
