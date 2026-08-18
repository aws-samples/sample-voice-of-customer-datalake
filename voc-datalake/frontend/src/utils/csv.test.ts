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

  it('neutralizes spreadsheet formula injection on leading = + - @ and control chars', () => {
    expect(csvField('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"')
    expect(csvField('+1234')).toBe('"\'+1234"')
    expect(csvField('-2+3')).toBe('"\'-2+3"')
    expect(csvField('@cmd')).toBe('"\'@cmd"')
    expect(csvField('\t=1+1')).toBe('"\'\t=1+1"')
  })

  it('leaves interior special characters untouched', () => {
    expect(csvField('a=b')).toBe('"a=b"')
    expect(csvField('rating: 5+')).toBe('"rating: 5+"')
  })
})
