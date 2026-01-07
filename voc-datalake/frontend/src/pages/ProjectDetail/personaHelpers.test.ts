import { describe, it, expect } from 'vitest'
import { getConfidenceClass } from './personaHelpers'

describe('personaHelpers', () => {
  describe('getConfidenceClass', () => {
    it('returns green classes for high confidence', () => {
      expect(getConfidenceClass('high')).toBe('bg-green-100 text-green-700')
    })

    it('returns yellow classes for medium confidence', () => {
      expect(getConfidenceClass('medium')).toBe('bg-yellow-100 text-yellow-700')
    })

    it('returns gray classes for undefined confidence', () => {
      expect(getConfidenceClass(undefined)).toBe('bg-gray-100 text-gray-600')
    })

    it('returns gray classes for unknown confidence', () => {
      expect(getConfidenceClass('unknown')).toBe('bg-gray-100 text-gray-600')
    })
  })
})
