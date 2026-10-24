import {
  describe, expect, it,
} from 'vitest'
import i18n from 'i18next'
import { useLocale } from '@test/i18n-locale'
import scrapersPl from '../../../public/locales/pl/scrapers.json'
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
  const t = i18n.t.bind(i18n)

  it.each([
    [0, 'Manual only'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'],
    [90, 'Every 90 minutes'], [180, 'Every 3 hours'], [720, 'Every 12 hours'], [1440, 'Daily'], [2880, 'Every 2 days'],
  ])('labels %i minutes "%s" (a translated sentence, never "15m")', (minutes, label) => {
    expect(getFrequencyLabel(minutes, t)).toBe(label)
  })

  it.each([Number.NaN, -5])('reads a runtime-sparse value (%s) as a dash, never "undefinedm"', (minutes) => {
    expect(getFrequencyLabel(minutes, t)).toBe('—')
  })

  describe('in Polish (verify10: "Manual only" untranslated)', () => {
    useLocale('pl', { scrapers: scrapersPl })

    it.each([
      [0, 'Tylko ręcznie'], [15, 'Co 15 minut'], [30, 'Co 30 minut'], [180, 'Co 3 godziny'],
      [360, 'Co 6 godzin'], [2880, 'Co 2 dni'],
    ])('labels %i minutes "%s" with the right plural form', (minutes, label) => {
      expect(getFrequencyLabel(minutes, i18n.t.bind(i18n))).toBe(label)
    })
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
