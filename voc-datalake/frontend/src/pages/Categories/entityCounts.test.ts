import { describe, it, expect } from 'vitest'
import { rankEntityKeys } from './entityCounts'

describe('rankEntityKeys', () => {
  it('ranks the keys of the requested map, most frequent first', () => {
    const response = { entities: { sources: { a: 1, b: 5, c: 3 }, categories: { x: 2 } } }

    expect(rankEntityKeys(response, 'sources')).toStrictEqual(['b', 'c', 'a'])
    expect(rankEntityKeys(response, 'categories')).toStrictEqual(['x'])
  })

  it('answers no keys for a missing response, entities object or map', () => {
    expect(rankEntityKeys(undefined, 'sources')).toStrictEqual([])
    expect(rankEntityKeys({}, 'sources')).toStrictEqual([])
    expect(rankEntityKeys({ entities: { categories: { x: 1 } } }, 'sources')).toStrictEqual([])
  })

  it('keeps a key whose count is not a number, ranked as zero', () => {
    const response = { entities: { sources: { a: 'many', b: 2 }, categories: {} } }

    expect(rankEntityKeys(response, 'sources')).toStrictEqual(['b', 'a'])
  })
})
