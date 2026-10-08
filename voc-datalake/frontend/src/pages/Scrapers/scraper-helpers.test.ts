import {
  describe, expect, it,
} from 'vitest'
import {
  countDefaultedDates, getAppIdentifier, getFrequencyLabel,
} from './scraper-helpers'

describe('getAppIdentifier', () => {
  it('returns app_id for iOS plugin', () => {
    expect(getAppIdentifier({ app_id: '547951480' }, 'app_reviews_ios')).toBe('547951480')
  })

  it('returns package_name for Android plugin', () => {
    expect(getAppIdentifier({ package_name: 'com.example.app' }, 'app_reviews_android')).toBe('com.example.app')
  })

  it('returns empty string for unknown plugin', () => {
    expect(getAppIdentifier({ app_id: '123' }, 'webscraper')).toBe('')
  })

  it('returns empty string when key is missing', () => {
    expect(getAppIdentifier({}, 'app_reviews_ios')).toBe('')
  })
})

describe('getFrequencyLabel', () => {
  it('returns Manual only for 0', () => {
    expect(getFrequencyLabel(0)).toBe('Manual only')
  })

  it('returns minute-based label for values under 60', () => {
    expect(getFrequencyLabel(15)).toBe('Every 15m')
    expect(getFrequencyLabel(30)).toBe('Every 30m')
  })

  it('returns Every hour for 60', () => {
    expect(getFrequencyLabel(60)).toBe('Every hour')
  })

  it('returns hour-based label for values between 60 and 1440', () => {
    expect(getFrequencyLabel(180)).toBe('Every 3h')
    expect(getFrequencyLabel(720)).toBe('Every 12h')
  })

  it('returns Daily for 1440', () => {
    expect(getFrequencyLabel(1440)).toBe('Daily')
  })

  it('returns Daily for values above 1440', () => {
    expect(getFrequencyLabel(2880)).toBe('Daily')
  })
})

describe('countDefaultedDates', () => {
  it('counts only importable reviews whose date is the import-date default', () => {
    expect(countDefaultedDates([
      { text: 'a', date: '2026-10-06', date_defaulted: true },
      { text: 'b', date: '2026-10-01', date_defaulted: false },
      { text: 'c', date: '2026-10-01' },
      { text: '  ', date: '2026-10-06', date_defaulted: true },
      { text: 'd', date: null, date_defaulted: true },
    ])).toBe(1)
  })
})
