/**
 * search_feedback under the user's floor (the page filters / the /chat panel scope): the model
 * narrows within it, an argument past it matches nothing, no floor reads as before, and the
 * panel's `limit` caps the matches used. Ported from #429 (search-feedback.scope.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { docClientReturning, makeFeedbackItem, runSearch } from './feedback-test-fixtures.js';
import { floorFromFilters } from '../assistant/tools/server/feedback-floor.js';

const ROWS = [
  makeFeedbackItem({ feedback_id: 'ws01'.padEnd(32, '0'), source_platform: 'webscraper', original_text: 'Late parcel' }),
  makeFeedbackItem({ feedback_id: 'mi01'.padEnd(32, '0'), source_platform: 'manual_import', original_text: 'Rude driver' }),
  makeFeedbackItem({ feedback_id: 's301'.padEnd(32, '0'), source_platform: 's3_import', original_text: 'Lost box', urgency: 'low' }),
];
const TWO_SOURCES = floorFromFilters({ source: 'webscraper,manual_import' });

function ids(items: { feedback_id?: string }[]): string[] {
  return items.map((item) => (item.feedback_id ?? '').slice(0, 4)).sort((a, b) => a.localeCompare(b));
}

describe('search_feedback floor', () => {
  it('keeps only the floor when the model passes no filter', async () => {
    const result = await runSearch(docClientReturning(ROWS), {}, { days: 1, floor: TWO_SOURCES });
    expect(ids(result.items)).toStrictEqual(['mi01', 'ws01']);
    expect(result.formatted).toContain('limited to the filters the user set');
  });

  it('lets the model narrow within the floor', async () => {
    const result = await runSearch(docClientReturning(ROWS), { source: 'webscraper' }, { days: 1, floor: TWO_SOURCES });
    expect(ids(result.items)).toStrictEqual(['ws01']);
  });

  it('intersects an argument past the floor to nothing, and says so', async () => {
    const result = await runSearch(docClientReturning(ROWS), { source: 's3_import' }, { days: 1, floor: TWO_SOURCES });
    expect(result.items).toStrictEqual([]);
    expect(result.formatted).toContain('"asked":"s3_import"');
  });

  it('counts only the floor in aggregate mode', async () => {
    const result = await runSearch(docClientReturning(ROWS), { mode: 'aggregate' }, { days: 1, floor: floorFromFilters({ urgent: '1' }) });
    expect(result.formatted).toContain('**Total matches:** 2');
  });

  it('reads as before without a floor', async () => {
    const result = await runSearch(docClientReturning(ROWS), {}, { days: 1 });
    expect(ids(result.items)).toStrictEqual(['mi01', 's301', 'ws01']);
    expect(result.formatted).not.toContain('filters the user set');
  });

  it('hides an id lookup outside the floor', async () => {
    const id = 'abcdef1234567890abcdef1234567890';
    const client = docClientReturning([makeFeedbackItem({ feedback_id: id, source_platform: 's3_import' })]);
    const result = await runSearch(client, { query: id }, { days: 7, floor: TWO_SOURCES });
    expect(result.items).toStrictEqual([]);
    expect(result.formatted).toContain('outside the filters the user set');
  });

  it('uses at most readLimit matches and says how many matched', async () => {
    const result = await runSearch(docClientReturning(ROWS), { mode: 'aggregate' }, { days: 1, readLimit: 2 });
    expect(result.formatted).toContain('**Total matches:** 2');
    expect(result.formatted).toContain('3 reviews matched');
  });
});
