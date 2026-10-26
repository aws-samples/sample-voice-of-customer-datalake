import { describe, expect, it } from 'vitest'
import { formatCount, formatDecimal, formatPercent } from './numberFormat'

// verify5/V6 item 3: de showed "17,066" and "92%" next to "92 %" — one spelling per locale.
describe('formatPercent', () => {
  it('follows the locale spelling', () => {
    expect(formatPercent(92, 'en')).toBe('92%')
    expect(formatPercent(92, 'de')).toBe('92\u00a0%')
  })

  it('keeps up to the requested decimals and treats non-finite as 0', () => {
    expect(formatPercent(16.04, 'en', 1)).toBe('16%')
    expect(formatPercent(Number.NaN, 'en')).toBe('0%')
  })
})

describe('formatCount', () => {
  it('groups for the locale', () => {
    expect(formatCount(17066, 'en')).toBe('17,066')
    expect(formatCount(17066, 'de')).toBe('17.066')
  })
})

// verify12: Polish showed the alerts cost "US$1.70" and the Radar sentiment axis "-0.5" with a dot.
describe('formatDecimal', () => {
  it('keeps exactly the requested decimals with the locale decimal mark', () => {
    expect(formatDecimal(1.7, 'en', 2)).toBe('1.70')
    expect(formatDecimal(1.7, 'pl', 2)).toBe('1,70')
    expect(formatDecimal(-0.5, 'pl', 1)).toBe('-0,5')
  })

  it('treats non-finite as 0', () => {
    expect(formatDecimal(Number.NaN, 'de', 2)).toBe('0,00')
  })
})
