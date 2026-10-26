/**
 * What the mutation run found the tool specs never pinned: the exact cut
 * boundaries of `clip` / `withinBudget` (a string AT the limit is untouched),
 * the full truncation notice, which values `pick` skips, and that `isRecord`
 * and `firstString` refuse `null` and the empty string.
 */
import { describe, expect, it } from 'vitest';
import { clip, firstString, isRecord, jsonResult, pick, withinBudget } from './format.js';

describe('isRecord', () => {
  it.each([
    [{ a: 1 }, true],
    [null, false],
    [[1], false],
    ['x', false],
    [undefined, false],
  ])('isRecord(%j) is %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('clip', () => {
  it('keeps a string at the limit and marks a longer one', () => {
    expect([clip('abc', 3), clip('abcd', 3), clip('', 0)]).toStrictEqual(['abc', 'abc…', '']);
  });
});

describe('withinBudget', () => {
  it('keeps content at the budget untouched', () => {
    expect(withinBudget('12345', 5)).toBe('12345');
  });

  it('cuts content over the budget and says so, with both lengths', () => {
    expect(withinBudget('123456', 5)).toBe(
      '12345\n\n[TRUNCATED: showing the first 5 of 6 characters. Say that the result was cut if it '
      + 'matters for the answer, or ask a narrower question.]',
    );
  });

  it('defaults to a 12,000-character budget', () => {
    const atBudget = 'x'.repeat(12_000);
    expect(withinBudget(atBudget)).toBe(atBudget);
    expect(withinBudget(`${atBudget}y`).startsWith(`${atBudget}\n\n[TRUNCATED: showing the first 12000 of 12001 characters.`))
      .toBe(true);
    expect(jsonResult({ a: 'x' }, 5)).toBe(withinBudget('{"a":"x"}', 5));
  });
});

describe('pick', () => {
  it('copies only the listed, present, non-empty keys and clips only strings', () => {
    const record = {
      keep: 'abcdef', number: 0, flag: false, list: ['abcdef'], empty: '', nil: null, missing: undefined, extra: 'x',
    };
    expect(pick(record, ['keep', 'number', 'flag', 'list', 'empty', 'nil', 'missing', 'absent'], 3)).toStrictEqual({
      keep: 'abc…', number: 0, flag: false, list: ['abcdef'],
    });
  });

  it('clips strings at 600 characters by default', () => {
    expect(pick({ text: 'y'.repeat(601) }, ['text'])).toStrictEqual({ text: `${'y'.repeat(600)}…` });
  });
});

describe('firstString', () => {
  it('skips empty strings and non-strings', () => {
    expect([firstString('', 5, 'a', 'b'), firstString('', null), firstString()]).toStrictEqual(['a', undefined, undefined]);
  });
});
