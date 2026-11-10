import { beforeAll, describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import i18n from 'i18next'
import {
  describeSentiment, netFromCounts, reviewSentimentText, sentimentShare, sentimentTone, sentimentWordKey,
  signedAverage,
} from './sentimentWords'
import deDashboard from '../../../public/locales/de/dashboard.json'

const t: TFunction = i18n.t.bind(i18n)

describe('sentimentWordKey', () => {
  it.each([
    [-0.78, 'mostlyNegative'], [-0.5, 'mostlyNegative'], [-0.3, 'leaningNegative'], [-0.1, 'balanced'],
    [0, 'balanced'], [0.2, 'leaningPositive'], [0.5, 'mostlyPositive'], [Number.NaN, 'balanced'],
  ])('%s reads as %s', (average, key) => {
    expect(sentimentWordKey(average)).toBe(key)
  })
})

describe('sentimentTone', () => {
  it('never reads a negative average as positive', () => {
    expect(sentimentTone(-0.2)).toBe('negative')
    expect(sentimentTone(-0.05)).toBe('neutral')
    expect(sentimentTone(0.4)).toBe('positive')
  })
})

describe('shares', () => {
  it('rounds the share of one label among every counted review', () => {
    expect(sentimentShare({ positive: 1, negative: 7, neutral: 1 }, 'negative')).toBe(78)
    expect(sentimentShare({}, 'negative')).toBeUndefined()
  })

  it('derives the net from label counts', () => {
    expect(netFromCounts({ negative: 2, positive: 1, neutral: 1 })).toBe(-0.25)
  })
})

describe('describeSentiment', () => {
  it('says the words and the share of the side they lean to', () => {
    expect(describeSentiment(t, -0.78, { negative: 78, positive: 12, neutral: 10 })).toBe('Mostly negative · 78% negative')
    expect(describeSentiment(t, 0.6, { negative: 1, positive: 3 })).toBe('Mostly positive · 75% positive')
  })

  it('says only the words when nothing is counted', () => {
    expect(describeSentiment(t, -0.78)).toBe('Mostly negative')
    expect(describeSentiment(t, -0.78, {})).toBe('Mostly negative')
  })
})

describe('signedAverage', () => {
  it('keeps the number as a signed secondary figure with a real minus', () => {
    expect(signedAverage(-0.78)).toBe('\u22120.78')
    expect(signedAverage(0.421)).toBe('+0.42')
    expect(signedAverage(0.001)).toBe('0.00')
  })

  // verify5/V6 item 3: the de Dashboard showed "−0.78" with an English decimal point.
  it('uses the locale decimal mark when given one', () => {
    expect(signedAverage(-0.78, 'de')).toBe('\u22120,78')
    expect(signedAverage(Number.NaN, 'de')).toBe('0,00')
  })
})

describe('reviewSentimentText', () => {
  it('reads one review as a word and a percent, never the raw score', () => {
    expect(reviewSentimentText(t, 'negative', -0.9)).toBe('Negative · 90%')
    expect(reviewSentimentText(t, 'positive', 0.854)).toBe('Positive · 85%')
    expect(reviewSentimentText(t, 'mixed', undefined)).toBe('Mixed')
    expect(reviewSentimentText(t, 'odd_label', 1.4)).toBe('Neutral · 100%')
  })
})

// verify5/V6 item 3: "92%" beside "92 %" — the share follows the locale's own percent spelling.
describe('share text per locale', () => {
  beforeAll(() => {
    i18n.addResourceBundle('de', 'dashboard', deDashboard)
  })

  it('writes "78 %" in German and "78%" in English', () => {
    const de: TFunction = i18n.getFixedT('de')
    expect(describeSentiment(de, -0.78, { negative: 78, positive: 22 })).toContain('78\u00a0% negativ')
    expect(describeSentiment(t, -0.78, { negative: 78, positive: 22 })).toContain('78% negative')
  })
})
