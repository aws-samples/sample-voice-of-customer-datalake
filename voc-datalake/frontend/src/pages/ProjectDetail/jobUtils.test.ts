import { describe, it, expect } from 'vitest'
import { getJobTypeLabel, isJobStale } from './jobUtils'

describe('jobUtils', () => {
  describe('getJobTypeLabel', () => {
    it('returns Research for research type', () => {
      expect(getJobTypeLabel('research')).toBe('Research')
    })

    it('returns PRD Generation for generate_prd type', () => {
      expect(getJobTypeLabel('generate_prd')).toBe('PRD Generation')
    })

    it('returns PR-FAQ Generation for generate_prfaq type', () => {
      expect(getJobTypeLabel('generate_prfaq')).toBe('PR-FAQ Generation')
    })

    it('returns Persona Generation for generate_personas type', () => {
      expect(getJobTypeLabel('generate_personas')).toBe('Persona Generation')
    })

    it('returns Persona Import for import_persona type', () => {
      expect(getJobTypeLabel('import_persona')).toBe('Persona Import')
    })

    it('returns Document Merge for unknown type', () => {
      expect(getJobTypeLabel('unknown')).toBe('Document Merge')
    })
  })

  describe('isJobStale', () => {
    const TEN_MINUTES_MS = 10 * 60 * 1000
    const now = Date.now()

    it('returns false for completed status', () => {
      const oldTime = new Date(now - TEN_MINUTES_MS - 1000).toISOString()
      expect(isJobStale('completed', oldTime, now)).toBe(false)
    })

    it('returns false for failed status', () => {
      const oldTime = new Date(now - TEN_MINUTES_MS - 1000).toISOString()
      expect(isJobStale('failed', oldTime, now)).toBe(false)
    })

    it('returns false when updatedAt is undefined', () => {
      expect(isJobStale('running', undefined, now)).toBe(false)
    })

    it('returns true for running job older than 10 minutes', () => {
      const oldTime = new Date(now - TEN_MINUTES_MS - 1000).toISOString()
      expect(isJobStale('running', oldTime, now)).toBe(true)
    })

    it('returns true for pending job older than 10 minutes', () => {
      const oldTime = new Date(now - TEN_MINUTES_MS - 1000).toISOString()
      expect(isJobStale('pending', oldTime, now)).toBe(true)
    })

    it('returns false for running job less than 10 minutes old', () => {
      const recentTime = new Date(now - TEN_MINUTES_MS + 1000).toISOString()
      expect(isJobStale('running', recentTime, now)).toBe(false)
    })
  })
})
