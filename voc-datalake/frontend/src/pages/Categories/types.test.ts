import { describe, it, expect } from 'vitest'
import {
  getSentimentScoreColorClass,
  getSentimentColor,
  categoryColors,
} from './types'

describe('types utilities', () => {
  describe('getSentimentScoreColorClass', () => {
    it('returns green for positive scores above 20', () => {
      expect(getSentimentScoreColorClass(21)).toBe('text-green-600')
      expect(getSentimentScoreColorClass(50)).toBe('text-green-600')
      expect(getSentimentScoreColorClass(100)).toBe('text-green-600')
    })

    it('returns red for negative scores below -20', () => {
      expect(getSentimentScoreColorClass(-21)).toBe('text-red-600')
      expect(getSentimentScoreColorClass(-50)).toBe('text-red-600')
      expect(getSentimentScoreColorClass(-100)).toBe('text-red-600')
    })

    it('returns gray for neutral scores between -20 and 20', () => {
      expect(getSentimentScoreColorClass(0)).toBe('text-gray-600')
      expect(getSentimentScoreColorClass(20)).toBe('text-gray-600')
      expect(getSentimentScoreColorClass(-20)).toBe('text-gray-600')
      expect(getSentimentScoreColorClass(10)).toBe('text-gray-600')
    })
  })

  describe('getSentimentColor', () => {
    it('returns correct hex colors for sentiments', () => {
      expect(getSentimentColor('positive')).toBe('#22c55e')
      expect(getSentimentColor('negative')).toBe('#ef4444')
      expect(getSentimentColor('neutral')).toBe('#6b7280')
      expect(getSentimentColor('mixed')).toBe('#eab308')
    })

    it('returns gray for unknown sentiment', () => {
      expect(getSentimentColor('unknown')).toBe('#6b7280')
    })
  })

  describe('categoryColors', () => {
    it('has colors for common categories', () => {
      expect(categoryColors.delivery).toBe('#ef4444')
      expect(categoryColors.customer_support).toBe('#f97316')
      expect(categoryColors.pricing).toBe('#22c55e')
      expect(categoryColors.other).toBe('#6b7280')
    })
  })

})
