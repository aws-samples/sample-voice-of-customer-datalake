import { describe, expect, it } from 'vitest'
import {
  normalizeDimensionMetrics, normalizeDimensionsConfig, normalizeDimensionsEdit, normalizeEntityExtras,
  parseDims, parseTagInput, pruneSelection, rankedNames, serializeDims, valueLabel, valuesUnder,
} from './dimensionsSchema'
import type { Dimension } from './dimensionsSchema'

const PRODUCT: Dimension = {
  key: 'product', label: 'Product', infer: true,
  values: [{ name: 'app', label: 'Mobile app' }, { name: 'web' }],
}
const MODULE: Dimension = {
  key: 'module', label: 'Module', infer: true, parent: 'product',
  values: [{ name: 'login', parent_value: 'app' }, { name: 'checkout', parent_value: 'web' }, { name: 'search' }],
}

describe('normalizeDimensionsConfig', () => {
  it('keeps good rows, defaults infer to true and the label to the key', () => {
    const config = normalizeDimensionsConfig({
      dimensions: [{ key: 'user_type', values: [{ name: 'partner' }, { nope: 1 }] }, 'junk'],
      updated_at: '2026-01-01',
    })
    expect(config).toStrictEqual({
      dimensions: [{ key: 'user_type', label: 'user_type', infer: true, values: [{ name: 'partner' }] }],
      updatedAt: '2026-01-01',
    })
  })

  it('reads a missing or malformed envelope as no dimensions', () => {
    expect(normalizeDimensionsConfig(null)).toStrictEqual({ dimensions: [] })
    expect(normalizeDimensionsConfig({ dimensions: 'x' })).toStrictEqual({ dimensions: [] })
  })
})

describe('parent narrowing', () => {
  it('offers only values under the chosen parent value, plus unparented ones', () => {
    expect(valuesUnder(MODULE, 'app').map((v) => v.name)).toStrictEqual(['login', 'search'])
    expect(valuesUnder(MODULE, undefined)).toHaveLength(3)
  })

  it('prunes a child value that no longer fits its parent, and unknown keys', () => {
    expect(pruneSelection([MODULE, PRODUCT], { product: 'web', module: 'login', other: 'x' }))
      .toStrictEqual({ product: 'web' })
    expect(pruneSelection([MODULE, PRODUCT], { product: 'web', module: 'checkout' }))
      .toStrictEqual({ product: 'web', module: 'checkout' })
  })

  it('labels a value by its label, else its name', () => {
    expect(valueLabel(PRODUCT, 'app')).toBe('Mobile app')
    expect(valueLabel(PRODUCT, 'web')).toBe('web')
  })
})

describe('dims param', () => {
  it('serializes sorted pairs and nothing for an empty selection', () => {
    expect(serializeDims({ product: 'app', module: 'login' })).toBe('module:login,product:app')
    expect(serializeDims({})).toBeUndefined()
    expect(serializeDims({ product: 'has space' })).toBeUndefined()
  })

  it('parses leniently: malformed and repeated pairs are skipped', () => {
    expect(parseDims('product:app,bad,Module:x,product:web,module:login'))
      .toStrictEqual({ product: 'app', module: 'login' })
    expect(parseDims(null)).toStrictEqual({})
  })
})

describe('parseTagInput', () => {
  it('splits on commas and semicolons, de-duplicates ignoring case and reports invalid tags', () => {
    expect(parseTagInput('VIP, billing; vip ,, a#b')).toStrictEqual({ tags: ['VIP', 'billing'], invalid: ['a#b'] })
  })
})

describe('normalizeDimensionMetrics', () => {
  it('ranks values by count and coerces string counts', () => {
    const metrics = normalizeDimensionMetrics({
      key: 'product', period_days: 30, is_partial: false, unassigned: '4',
      values: { web: { count: 2, positive: 1 }, app: { count: '5', negative: 5 } },
    })
    expect(metrics.values.map((v) => [v.name, v.count])).toStrictEqual([['app', 5], ['web', 2]])
    expect(metrics.unassigned).toBe(4)
    expect(metrics.values[1]).toStrictEqual({ name: 'web', count: 2, positive: 1, negative: 0, neutral: 0, mixed: 0 })
  })

  it('survives a junk response', () => {
    expect(normalizeDimensionMetrics('x')).toStrictEqual({ key: '', periodDays: 0, isPartial: false, values: [], unassigned: 0 })
  })
})

describe('normalizeEntityExtras', () => {
  it('reads the additions at the top level or nested under entities', () => {
    const top = normalizeEntityExtras({ channels: { review: 3 }, tags: { vip: '2', zero: 0 } })
    const nested = normalizeEntityExtras({ entities: { dimensions: { product: { app: 4 } } } })
    expect(top).toStrictEqual({ channels: { review: 3 }, tags: { vip: 2 }, dimensions: {} })
    expect(nested.dimensions).toStrictEqual({ product: { app: 4 } })
  })

  it('ranks names by count then name', () => {
    expect(rankedNames({ b: 1, a: 1, c: 5 })).toStrictEqual(['c', 'a', 'b'])
  })
})

describe('normalizeDimensionsEdit', () => {
  it('keeps string values and string tags only', () => {
    expect(normalizeDimensionsEdit({ feedback_id: 'f1', dimensions: { product: 'app', n: 1 }, tags: ['vip', 3] }))
      .toStrictEqual({ feedback_id: 'f1', dimensions: { product: 'app' }, tags: ['vip'] })
  })
})
