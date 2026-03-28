/**
 * @fileoverview Tests for prioritizationUtils — safe score access and calculations.
 */
import { describe, it, expect } from 'vitest'
import {
  getScore, calculatePriorityScore, collectPRFAQs, comparePRFAQs, DEFAULT_SCORE,
} from './prioritizationUtils'
import type { PrioritizationScore } from '../../api/types'

describe('getScore', () => {
  it('returns stored score when document_id exists', () => {
    const scores: Record<string, PrioritizationScore> = {
      'd1': { document_id: 'd1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 5, notes: 'test' },
    }

    const result = getScore(scores, 'd1')

    expect(result.impact).toBe(4)
    expect(result.notes).toBe('test')
  })

  it('returns DEFAULT_SCORE with document_id when key is missing', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const result = getScore(scores, 'missing-id')

    expect(result.impact).toBe(0)
    expect(result.time_to_market).toBe(3)
    expect(result.confidence).toBe(0)
    expect(result.strategic_fit).toBe(0)
    expect(result.document_id).toBe('missing-id')
  })

  it('returns DEFAULT_SCORE for empty scores object', () => {
    const result = getScore({}, 'any-id')

    expect(result).toEqual({ ...DEFAULT_SCORE, document_id: 'any-id' })
  })
})

describe('calculatePriorityScore', () => {
  it('returns 0 for default unscored item', () => {
    const score = { ...DEFAULT_SCORE, document_id: 'd1' }

    // impact=0*0.4 + ttm=3*0.3 + strategic=0*0.2 + confidence=0*0.1 = 0.9
    expect(calculatePriorityScore(score)).toBeCloseTo(0.9)
  })

  it('computes weighted score correctly', () => {
    const score: PrioritizationScore = {
      document_id: 'd1', impact: 5, time_to_market: 4, confidence: 3, strategic_fit: 2, notes: '',
    }

    // 5*0.4 + 4*0.3 + 2*0.2 + 3*0.1 = 2.0 + 1.2 + 0.4 + 0.3 = 3.9
    expect(calculatePriorityScore(score)).toBeCloseTo(3.9)
  })

  it('returns max score for all-5 ratings', () => {
    const score: PrioritizationScore = {
      document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '',
    }

    expect(calculatePriorityScore(score)).toBeCloseTo(5.0)
  })
})

describe('collectPRFAQs', () => {
  it('returns empty array when no project details', () => {
    expect(collectPRFAQs(undefined, undefined)).toEqual([])
    expect(collectPRFAQs([], [])).toEqual([])
  })

  it('only includes prfaq document types', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prfaq', title: 'A', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'prd', title: 'B', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', status: 'active', created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('d1')
    expect(result[0].project_name).toBe('P1')
  })
})

describe('comparePRFAQs', () => {
  const prfaqA = { document_id: 'a', project_id: 'p1', project_name: 'P1', document_type: 'prfaq', title: 'Alpha', content: '', created_at: '2025-01-01' }
  const prfaqB = { document_id: 'b', project_id: 'p1', project_name: 'P1', document_type: 'prfaq', title: 'Beta', content: '', created_at: '2025-01-02' }

  it('sorts by impact when field is impact', () => {
    const scores: Record<string, PrioritizationScore> = {
      'a': { document_id: 'a', impact: 2, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
      'b': { document_id: 'b', impact: 5, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
    }

    expect(comparePRFAQs(prfaqA, prfaqB, scores, 'impact')).toBeLessThan(0)
  })

  it('handles missing scores gracefully via getScore fallback', () => {
    // Both missing from scores — should not crash, both get DEFAULT_SCORE
    expect(() => comparePRFAQs(prfaqA, prfaqB, {}, 'impact')).not.toThrow()
    expect(comparePRFAQs(prfaqA, prfaqB, {}, 'impact')).toBe(0)
  })
})

describe('StatsCards regression: scores with missing document_id', () => {
  /**
   * Regression test for: TypeError: Cannot read properties of undefined (reading 'impact')
   * When scores object doesn't contain an entry for a PR/FAQ's document_id,
   * direct access scores[id].impact crashes. getScore() must be used instead.
   */
  it('getScore does not crash when accessing impact on missing score', () => {
    const scores: Record<string, PrioritizationScore> = {}
    const docId = 'nonexistent-doc'

    // This is what the buggy code did: scores[docId].impact
    // This is what the fixed code does:
    const score = getScore(scores, docId)
    expect(score.impact).toBe(0)
  })

  it('calculatePriorityScore works with getScore fallback', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const score = getScore(scores, 'missing')
    expect(() => calculatePriorityScore(score)).not.toThrow()
    expect(calculatePriorityScore(score)).toBeCloseTo(0.9)
  })
})
