/**
 * @fileoverview What the import wizard sends (wizardMapping.ts): a reviews file's mapping with its dimensions, the
 * problems that stop an import, the import's tag, the rows' calls and the imported form's name.
 */
import { describe, expect, it } from 'vitest'
import type { Dimension } from '../../../api/dimensionsSchema'
import { chunksOf, dimensionFor, formName, importTag, wizardMappingProblem, reviewsMapping } from './wizardMapping'

const dimension = (key: string, label: string): Dimension => ({ key, label, infer: false, values: [] })
const DIMENSIONS = [dimension('product', 'Product line'), dimension('user_type', 'Type of user')]

describe('a reviews file', () => {
  it('fills a dimension from a choice column named like it, by key or label', () => {
    expect(dimensionFor('Product', DIMENSIONS)?.key).toBe('product')
    expect(dimensionFor(' Type of úser ', DIMENSIONS)?.key).toBe('user_type')
    expect(dimensionFor('Plan', DIMENSIONS)).toBeUndefined()
    expect(reviewsMapping({ Comment: 'open_text', Product: 'choice', 'Type of user': 'choice', Plan: 'choice',
                            Mail: 'email' }, DIMENSIONS)).toStrictEqual({
      Comment: 'open_text', Product: 'dimension:product', 'Type of user': 'dimension:user_type', Plan: 'choice',
      Mail: 'email' })
  })

  it('needs an open-text column, a survey a question', () => {
    expect(wizardMappingProblem({ A: 'choice' }, 'reviews')).toBe('noText')
    expect(wizardMappingProblem({ A: 'open_text' }, 'reviews')).toBeNull()
    expect(wizardMappingProblem({ A: 'date', B: 'email' }, 'survey')).toBe('noQuestion')
    expect(wizardMappingProblem({ A: 'nps_0_10' }, 'survey')).toBeNull()
  })
})

describe('sending', () => {
  it('tags an import with its day and four letters', () => {
    expect(importTag(new Date('2026-11-21T10:00:00Z'), () => 0)).toBe('import-2026-11-21-aaaa')
    expect(importTag(new Date('2026-11-21T10:00:00Z'))).toMatch(/^import-2026-11-21-[a-z2-9]{4}$/u)
  })

  it('sends rows in runs, each with its offset', () => {
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toStrictEqual([
      { offset: 0, items: [1, 2] }, { offset: 2, items: [3, 4] }, { offset: 4, items: [5] }])
    expect(chunksOf([], 2)).toStrictEqual([])
  })

  it('names an imported form after its file', () => {
    expect(formName('Workshop results.csv')).toBe('Workshop results')
    expect(formName('.csv')).toBe('.csv')
  })
})
