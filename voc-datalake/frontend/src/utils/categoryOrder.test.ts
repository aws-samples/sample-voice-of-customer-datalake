import { describe, expect, it } from 'vitest'
import { rankCategoryEntries, topCategoryEntries } from './categoryOrder'

describe('rankCategoryEntries', () => {
  it('ranks largest first, ties by name, with "other" always last', () => {
    expect(rankCategoryEntries([['other', 50], ['b', 2], ['a', 2], ['c', 9]]).map(([name]) => name))
      .toStrictEqual(['c', 'a', 'b', 'other'])
  })

  it('leaves its input untouched', () => {
    const input: [string, number][] = [['b', 1], ['a', 2]]
    rankCategoryEntries(input)
    expect(input).toStrictEqual([['b', 1], ['a', 2]])
  })
})

describe('topCategoryEntries', () => {
  it('cuts by size first, then moves "other" to the end', () => {
    expect(topCategoryEntries([['a', 1], ['other', 40], ['b', 5], ['c', 3]], 3).map(([name]) => name))
      .toStrictEqual(['b', 'c', 'other'])
  })

  it('drops "other" when it does not make the cut', () => {
    expect(topCategoryEntries([['a', 9], ['other', 1], ['b', 5]], 2)).toStrictEqual([['a', 9], ['b', 5]])
  })
})
