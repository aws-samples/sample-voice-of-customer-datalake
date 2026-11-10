import { describe, expect, it } from 'vitest'
import { normalizeDimensionsConfig } from '../../api/dimensionsSchema'
import { dimensionsWire } from '@test/dimensionFixtures'
import {
  draftProblem, newDimension, newValue, parentOptions, removeDimension, replaceDimension, toDraft, toWire,
} from './dimensionDraft'
import type { DraftDimension } from './dimensionDraft'

const stored = normalizeDimensionsConfig(dimensionsWire).dimensions

function draftWith(change: (d: DraftDimension[]) => DraftDimension[]): DraftDimension[] {
  return change(toDraft(stored))
}

describe('toDraft / toWire', () => {
  it('round-trips the stored config without client ids', () => {
    expect(toWire(toDraft(stored))).toStrictEqual(stored)
  })

  it('trims text, defaults an empty label to the key and drops parent values of a top-level dimension', () => {
    const [dimension] = toWire([{ ...newDimension(), key: ' tier ', label: '', values: [{ ...newValue(' gold '), parent_value: 'x', label: ' ' }] }])
    expect(dimension).toStrictEqual({ key: 'tier', label: 'tier', infer: true, values: [{ name: 'gold' }] })
  })
})

describe('draftProblem', () => {
  it('accepts the stored config', () => {
    expect(draftProblem(toDraft(stored))).toBeNull()
  })

  it.each([
    ['keyFormat', (d: DraftDimension[]) => [...d, { ...newDimension(), key: 'Bad Key' }]],
    ['keyReserved', (d: DraftDimension[]) => [...d, { ...newDimension(), key: 'category' }]],
    ['keyDuplicate', (d: DraftDimension[]) => [...d, { ...newDimension(), key: 'product' }]],
    ['valueFormat', (d: DraftDimension[]) => [{ ...newDimension(), key: 'tier', values: [newValue('has space')] }, ...d]],
    ['valueDuplicate', (d: DraftDimension[]) => [{ ...newDimension(), key: 'tier', values: [newValue('a'), newValue('a')] }, ...d]],
  ])('reports %s', (problem, change) => {
    expect(draftProblem(draftWith(change))?.messageKey).toBe(`components:dimensionsManager.problems.${problem}`)
  })

  it('reports a child value whose parent value was removed', () => {
    const draft = draftWith((d) => d.map((x) => (x.key === 'product' ? { ...x, values: x.values.filter((v) => v.name !== 'web_shop') } : x)))
    expect(draftProblem(draft)).toStrictEqual({
      messageKey: 'components:dimensionsManager.problems.parentValueMissing', params: { key: 'module', value: 'checkout' },
    })
  })
})

describe('parent links', () => {
  it('offers only other top-level dimensions, and none to a dimension that has children', () => {
    const draft = toDraft(stored)
    const [product, module, userType] = draft
    expect(parentOptions(draft, module ?? newDimension()).map((d) => d.key)).toStrictEqual(['product', 'user_type'])
    expect(parentOptions(draft, product ?? newDimension())).toStrictEqual([])
    expect(parentOptions(draft, userType ?? newDimension()).map((d) => d.key)).toStrictEqual(['product'])
  })

  it('moves children with a renamed parent and frees them when it is removed', () => {
    const draft = toDraft(stored)
    const product = draft[0] ?? newDimension()
    const renamed = replaceDimension(draft, product.uid, { ...product, key: 'app' })
    expect(renamed.find((d) => d.key === 'module')?.parent).toBe('app')
    expect(removeDimension(draft, product.uid).find((d) => d.key === 'module')?.parent).toBeUndefined()
  })
})
