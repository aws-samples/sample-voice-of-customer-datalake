import { describe, it, expect } from 'vitest'
import {
  getSentimentScoreColorClass,
  getSentimentColorClass,
  getSentimentColor,
  categoryColors,
  sentimentColors,
  matchesRatingFilter,
  ratingFilterLabel,
  ANY_RATING_FILTER,
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

  describe('getSentimentColorClass', () => {
    it('returns green classes for positive', () => {
      expect(getSentimentColorClass('positive')).toBe('bg-green-100 text-green-800')
    })

    it('returns red classes for negative', () => {
      expect(getSentimentColorClass('negative')).toBe('bg-red-100 text-red-800')
    })

    it('returns yellow classes for mixed', () => {
      expect(getSentimentColorClass('mixed')).toBe('bg-yellow-100 text-yellow-800')
    })

    it('returns gray classes for neutral and unknown', () => {
      expect(getSentimentColorClass('neutral')).toBe('bg-gray-100 text-gray-800')
      expect(getSentimentColorClass('unknown')).toBe('bg-gray-100 text-gray-800')
      expect(getSentimentColorClass(undefined)).toBe('bg-gray-100 text-gray-800')
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

  describe('sentimentColors', () => {
    it('has colors for all sentiments', () => {
      expect(sentimentColors.positive).toBe('#22c55e')
      expect(sentimentColors.negative).toBe('#ef4444')
      expect(sentimentColors.neutral).toBe('#6b7280')
      expect(sentimentColors.mixed).toBe('#eab308')
    })
  })

  describe('matchesRatingFilter', () => {
    it('passes everything when the threshold is 0 (any rating)', () => {
      expect(matchesRatingFilter(5, ANY_RATING_FILTER)).toBe(true)
      expect(matchesRatingFilter(undefined, ANY_RATING_FILTER)).toBe(true)
      expect(matchesRatingFilter(0, { value: 0, direction: 'below' })).toBe(true)
    })

    it('keeps ratings at or above the threshold with & up', () => {
      expect(matchesRatingFilter(3, { value: 3, direction: 'up' })).toBe(true)
      expect(matchesRatingFilter(5, { value: 3, direction: 'up' })).toBe(true)
      expect(matchesRatingFilter(2, { value: 3, direction: 'up' })).toBe(false)
    })

    it('keeps ratings at or below the threshold with & below', () => {
      expect(matchesRatingFilter(3, { value: 3, direction: 'below' })).toBe(true)
      expect(matchesRatingFilter(1, { value: 3, direction: 'below' })).toBe(true)
      expect(matchesRatingFilter(4, { value: 3, direction: 'below' })).toBe(false)
    })

    it('excludes unrated items in both directions once a threshold is set', () => {
      expect(matchesRatingFilter(undefined, { value: 3, direction: 'up' })).toBe(false)
      expect(matchesRatingFilter(undefined, { value: 3, direction: 'below' })).toBe(false)
    })
  })

  describe('ratingFilterLabel', () => {
    it('formats the & up direction as N+', () => {
      expect(ratingFilterLabel({ value: 4, direction: 'up' })).toBe('4+ stars')
    })

    it('formats the & below direction as ≤N', () => {
      expect(ratingFilterLabel({ value: 3, direction: 'below' })).toBe('≤3 stars')
    })
  })
})
