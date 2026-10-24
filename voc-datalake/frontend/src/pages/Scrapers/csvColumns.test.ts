import { describe, expect, it } from 'vitest'
import { normalizeDimensionsConfig } from '../../api/dimensionsSchema'
import { dimensionsWire } from '@test/dimensionFixtures'
import { mappingProblem, parseCsvHeader, suggestMapping, suggestTarget, targetOptions } from './csvColumns'

const dimensions = normalizeDimensionsConfig(dimensionsWire).dimensions

describe('parseCsvHeader', () => {
  it('reads quoted cells with commas and doubled quotes, and strips a BOM', () => {
    expect(parseCsvHeader('\uFEFF"Text, long",Rating,"Say ""hi"""\r\n1,2,3')).toStrictEqual(['Text, long', 'Rating', 'Say "hi"'])
  })

  it('keeps a trailing empty cell and reads an empty file as no header', () => {
    expect(parseCsvHeader('a,b,\n')).toStrictEqual(['a', 'b', ''])
    expect(parseCsvHeader('')).toStrictEqual([])
  })
})

describe('suggestTarget', () => {
  it.each([
    ['Review', 'text'], ['STARS', 'rating'], ['source', 'channel'], ['Labels', 'tags'],
    ['product', 'dimension:product'], ['User type', 'dimension:user_type'], ['Region', 'metadata'],
  ])('maps %s to %s', (header, target) => {
    expect(suggestTarget(header, dimensions)).toBe(target)
  })
})

describe('suggestMapping', () => {
  it('maps a second synonym of a taken field to metadata, and skips blank or repeated headers', () => {
    expect(suggestMapping(['review', 'comment', '', 'review'], dimensions)).toStrictEqual({ review: 'text', comment: 'metadata' })
  })
})

describe('mappingProblem', () => {
  it('requires a text column and refuses a field chosen twice', () => {
    expect(mappingProblem({ a: 'metadata' })?.messageKey).toBe('scrapers:csvUpload.mapping.problems.noText')
    expect(mappingProblem({ a: 'text', b: 'dimension:product', c: 'dimension:product' })?.params).toStrictEqual({ target: 'dimension:product' })
    expect(mappingProblem({ a: 'text', b: 'metadata', c: 'metadata', d: 'ignore', e: 'ignore' })).toBeNull()
  })

  it('offers every field, one target per dimension, metadata and ignore', () => {
    expect(targetOptions(dimensions).slice(-5)).toStrictEqual(['dimension:product', 'dimension:module', 'dimension:user_type', 'metadata', 'ignore'])
  })
})
