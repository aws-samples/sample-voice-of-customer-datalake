/**
 * Axis sizing for the Dashboard charts: number ticks are compact in every locale
 * ("10K", "10 Tsd.") and number axes measure their rendered ticks (width "auto"),
 * category axes from their longest label, clamped so a phone keeps room for bars.
 */
import { describe, expect, it } from 'vitest'
import { NUMBER_AXIS_WIDTH, barChartHeight, categoryAxisWidth, compactFormatter, sentimentTickFormatter } from './axisLabel'

const en = compactFormatter('en')

describe('compactFormatter', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [10000, '10K'],
    [12500, '12.5K'],
    [1500000, '1.5M'],
  ])('%i → %s', (value, label) => {
    expect(en(value)).toBe(label)
  })

  it('renders a non-number as text', () => {
    expect([en('2026-10-01'), en(undefined), en(Number.NaN)]).toStrictEqual(['2026-10-01', '', 'NaN'])
  })

  it('follows the UI language', () => {
    expect([compactFormatter('es')(10000), compactFormatter('fr')(7500)]).toStrictEqual(['10\u00a0mil', '7,5\u00a0k'])
  })

  // verify4 V4: German compact notation prints thousands whole ("10.000", "7500").
  it.each([
    [10000, '10\u00a0Tsd.'],
    [7500, '7,5\u00a0Tsd.'],
    [950, '950'],
    [1500000, '1,5\u00a0Mio.'],
  ])('abbreviates German thousands: %i → %s', (value, label) => {
    expect(compactFormatter('de')(value)).toBe(label)
  })

  it('keeps a locale whose compact form already shortens ten thousand (1万) as Intl writes it', () => {
    expect([compactFormatter('ja')(10000), compactFormatter('ja')(7500)]).toStrictEqual(['1万', '7500'])
  })
})

describe('NUMBER_AXIS_WIDTH', () => {
  it('lets Recharts measure the rendered ticks instead of estimating them', () => {
    expect(NUMBER_AXIS_WIDTH).toBe('auto')
  })
})

describe('categoryAxisWidth / barChartHeight', () => {
  it('sizes to the longest label, clamped to 48–128 px', () => {
    expect([
      categoryAxisWidth(['Web', 'App']),
      categoryAxisWidth(['Customer support']),
      categoryAxisWidth(['Acme airlines main (Trustpilot)']),
    ]).toStrictEqual([48, 118, 128])
  })

  it('honours a narrower maximum', () => {
    expect(categoryAxisWidth(['Acme airlines main (Trustpilot)'], 90)).toBe(90)
  })

  it('gives every bar a readable row, never below 200 px', () => {
    expect([barChartHeight(0), barChartHeight(9)]).toStrictEqual([200, 310])
  })
})

// verify5/V6 item 3: the de trend's right axis read "-0.5" (English decimal, hyphen).
describe('sentimentTickFormatter', () => {
  it('writes −1 … +1 ticks in the locale with a real minus', () => {
    expect(sentimentTickFormatter('de')(-0.5)).toBe('\u22120,5')
    expect(sentimentTickFormatter('en')(0.5)).toBe('0.5')
  })
})
