import { describe, expect, it } from 'vitest'
import { sameJson } from './sameJson'

describe('sameJson', () => {
  it('compares JSON shapes, key order included, and keeps undefined apart from null', () => {
    const shared = { a: 1 }
    expect([
      sameJson(shared, shared),
      sameJson({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }),
      sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }),
      sameJson(undefined, undefined),
      sameJson(undefined, null),
      sameJson('1', 1),
    ]).toStrictEqual([true, true, false, true, false, false])
  })
})
