/**
 * @fileoverview Tests for prioritizationUtils — safe score access and calculations.
 */
import { describe, it, expect } from 'vitest'
import {
  getScore, calculatePriorityScore, collectPRFAQs, comparePRFAQs, DEFAULT_SCORE, isScorable,
} from './prioritizationUtils'
import type { PrioritizationScore, ProjectDocument } from '../../api/types'

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
    expect(result.document_id).toBe('missing-id')
  })

  it('returns DEFAULT_SCORE for empty scores object', () => {
    const result = getScore({}, 'any-id')

    expect(result).toStrictEqual({ ...DEFAULT_SCORE, document_id: 'any-id' })
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

describe('isScorable', () => {
  it('returns true for prfaq documents', () => {
    const doc = { document_id: 'd1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns true for prd documents', () => {
    const doc: ProjectDocument = { document_id: 'd2', document_type: 'prd', title: 'B', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns false for non-scorable document types', () => {
    const types: ProjectDocument['document_type'][] = ['research', 'custom', 'product_report', 'prototype']
    for (const document_type of types) {
      const doc: ProjectDocument = { document_id: 'dx', document_type, title: 'X', content: '', created_at: '2025-01-01' }
      expect(isScorable(doc)).toBe(false)
    }
  })
})

describe('collectPRFAQs', () => {
  it('returns empty array when no project details', () => {
    expect(collectPRFAQs(undefined, undefined)).toStrictEqual([])
    expect(collectPRFAQs([], [])).toStrictEqual([])
  })

  it('includes prfaq document types', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('d1')
    expect(result[0].document_type).toBe('prfaq')
    expect(result[0].project_name).toBe('P1')
  })

  it('includes prd document types', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prd' as const, title: 'My PRD', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('d1')
    expect(result[0].document_type).toBe('prd')
    expect(result[0].project_name).toBe('P1')
  })

  it('collects both prd and prfaq from the same project', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prfaq' as const, title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'prd' as const, title: 'Feature A PRD', content: '', created_at: '2025-01-02' },
        { document_id: 'd3', document_type: 'research' as const, title: 'Research', content: '', created_at: '2025-01-03' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(2)
    const ids = result.map((r) => r.document_id)
    expect(ids).toContain('d1')
    expect(ids).toContain('d2')
  })

  it('excludes non-scorable document types (research, custom, product_report, prototype)', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'custom' as const, title: 'C', content: '', created_at: '2025-01-01' },
        { document_id: 'd3', document_type: 'product_report' as const, title: 'PR', content: '', created_at: '2025-01-01' },
        { document_id: 'd4', document_type: 'prototype' as const, title: 'Proto', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(0)
  })

  it('attaches the most-recent prototype to each scorable document', () => {
    const details = [{
      documents: [
        { document_id: 'prfaq1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' },
        { document_id: 'proto-old', document_type: 'prototype' as const, title: 'Old Proto', content: '', created_at: '2025-01-10' },
        { document_id: 'proto-new', document_type: 'prototype' as const, title: 'New Proto', content: '', created_at: '2025-02-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].prototype?.document_id).toBe('proto-new')
  })
})

describe('comparePRFAQs', () => {
  const prfaqA = { document_id: 'a', project_id: 'p1', project_name: 'P1', document_type: 'prfaq' as const, title: 'Alpha', content: '', created_at: '2025-01-01' }
  const prfaqB = { document_id: 'b', project_id: 'p1', project_name: 'P1', document_type: 'prfaq' as const, title: 'Beta', content: '', created_at: '2025-01-02' }

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
