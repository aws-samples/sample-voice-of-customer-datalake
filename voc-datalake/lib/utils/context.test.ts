import { describe, it, expect } from 'vitest';
import { recordOrEmpty, stringOr } from './context';

describe('stringOr', () => {
  it('keeps a non-empty string', () => {
    expect(stringOr('Acme', 'MyBrand')).toBe('Acme');
  });

  it.each([undefined, null, '', 42, true, {}])('falls back for %o (empty means unset)', (value) => {
    expect(stringOr(value, 'MyBrand')).toBe('MyBrand');
  });
});

describe('recordOrEmpty', () => {
  it('keeps a plain object', () => {
    expect(recordOrEmpty({ webscraper: true })).toStrictEqual({ webscraper: true });
  });

  it.each([undefined, null, 'x', 1, ['webscraper']])('returns {} for %o', (value) => {
    expect(recordOrEmpty(value)).toStrictEqual({});
  });
});
