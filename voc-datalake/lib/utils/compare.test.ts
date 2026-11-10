import { describe, expect, it } from 'vitest';

import { byCodeUnit } from './compare';

describe('byCodeUnit', () => {
  it('orders by UTF-16 code unit, where localeCompare would not', () => {
    // Upper before lower ('A' 65 < 'a' 97), '_' (95) before 'b' (98) and '{'
    // (123) after every letter: the cases a locale-aware comparator reorders
    // and a bare `.sort()` does not. Written out by hand so the oracle is not
    // the code under test.
    const input = ['b', 'B', 'a_b', 'ab', '{x}', 'A', 'z', ''];

    expect([...input].sort(byCodeUnit)).toStrictEqual(['', 'A', 'B', 'a_b', 'ab', 'b', 'z', '{x}']);
  });

  it('treats equal strings as equal', () => {
    expect(byCodeUnit('same', 'same')).toBe(0);
  });
});
