import { describe, it, expect } from 'vitest'
import { getConfidenceClass } from './personaHelpers'

describe('personaHelpers', () => {
  describe('getConfidenceClass', () => {
    it('returns green classes for high confidence', () => {
      expect(getConfidenceClass('high')).toBe('bg-ok-subtle text-ok')
    })

    it('returns yellow classes for medium confidence', () => {
      expect(getConfidenceClass('medium')).toBe('bg-warn-subtle text-warn')
    })

    it('returns gray classes for undefined confidence', () => {
      expect(getConfidenceClass(undefined)).toBe('bg-bg-hover text-text')
    })

    it('returns gray classes for unknown confidence', () => {
      expect(getConfidenceClass('unknown')).toBe('bg-bg-hover text-text')
    })
  })
})
