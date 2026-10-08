import { describe, it, expect } from 'vitest'
import { csvField } from './csv'

describe('csvField', () => {
  it('quotes every field and doubles embedded quotes', () => {
    expect(csvField('plain')).toBe('"plain"')
    expect(csvField('with, comma')).toBe('"with, comma"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
  })

  it('renders numbers, null and undefined safely', () => {
    expect(csvField(5)).toBe('"5"')
    expect(csvField('')).toBe('""')
    expect(csvField(null)).toBe('""')
    expect(csvField(undefined)).toBe('""')
  })

  it.each([
    ['=SUM(A1:A9)', '"\'=SUM(A1:A9)"'],
    ['+1234', '"\'+1234"'],
    ['-2+3', '"\'-2+3"'],
    ['@cmd', '"\'@cmd"'],
    ['\t=1+1', '"\'\t=1+1"'],
  ])('neutralizes spreadsheet formula injection: %j → %j', (input, expected) => {
    expect(csvField(input)).toBe(expected)
  })

  it('leaves interior special characters untouched', () => {
    expect(csvField('a=b')).toBe('"a=b"')
    expect(csvField('rating: 5+')).toBe('"rating: 5+"')
  })
})
