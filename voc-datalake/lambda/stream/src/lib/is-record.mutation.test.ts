/**
 * `isRecord` is the guard every boundary in this Lambda narrows `unknown` with,
 * yet the mutation run found no spec that called it directly: every caller's
 * spec reached it only through module mocks, so all twelve of its mutants ran
 * uncovered. These cases pin each side of each of its three conditions.
 */
import { describe, expect, it } from 'vitest';
import { isRecord } from './is-record.js';

const NULL_PROTOTYPE: object = Object.create(null);

describe('isRecord admits plain objects only', () => {
  it.each([
    ['an empty object', {}, true],
    ['an object with keys', { a: 1 }, true],
    ['a null-prototype object', NULL_PROTOTYPE, true],
    ['null', null, false],
    ['undefined', undefined, false],
    ['an array', [1], false],
    ['an empty array', [], false],
    ['a string', 'object', false],
    ['a number', 0, false],
    ['a function', () => ({}), false],
  ])('%s -> %s', (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});
