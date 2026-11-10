import { describe, expect, it } from 'vitest'
import { tooltipFormatter } from './chartTooltip'

describe('tooltipFormatter', () => {
  it('writes counts with the reader\'s grouping and keeps the series name', () => {
    expect(tooltipFormatter('de')(12345, 'Bewertungen')).toStrictEqual(['12.345', 'Bewertungen'])
  })

  it('signs an average sentiment series with two decimals', () => {
    expect(tooltipFormatter('en', ['Avg sentiment'])(-0.4166, 'Avg sentiment')).toStrictEqual(['\u22120.42', 'Avg sentiment'])
  })

  it('passes a value that is not a number through as text', () => {
    expect(tooltipFormatter('en')('n/a', 'Reviews')).toStrictEqual(['n/a', 'Reviews'])
  })
})
