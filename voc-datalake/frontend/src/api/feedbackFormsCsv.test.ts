import { describe, expect, it } from 'vitest'
import { dispositionFilename, csvFilename, csvParams } from './feedbackFormsCsv'

describe('the responses CSV', () => {
  it('asks for a layout, and for the row of ids only when wanted', () => {
    expect(csvParams({ layout: 'familiar', ids: false })).toStrictEqual({ format: 'csv', layout: 'familiar' })
    expect(csvParams({ layout: 'familiar', ids: true })).toStrictEqual({ format: 'csv', layout: 'familiar', ids: 'true' })
    expect(csvParams({ layout: 'detailed', ids: false })).toStrictEqual({ format: 'csv', layout: 'detailed' })
  })

  it('reads the name an answer gives, never a path', () => {
    expect(dispositionFilename('attachment; filename="workshop-responses-2026-11-20.csv"')).toBe('workshop-responses-2026-11-20.csv')
    expect([dispositionFilename(null), dispositionFilename('attachment'), dispositionFilename('attachment; filename="../x.csv"')]).toStrictEqual([null, null, null])
  })

  it("names the file after the form's name, accents folded, at most 60 characters, else its id", () => {
    const day = new Date('2026-11-20T23:59:00Z')
    expect(csvFilename('  Évaluation — Atelier Łódź  ', 'ff_1', 'familiar', day)).toBe('evaluation-atelier-lodz-responses-2026-11-20.csv')
    expect(csvFilename(`${'a'.repeat(59)} b`, 'ff_1', 'familiar', day)).toBe(`${'a'.repeat(59)}-responses-2026-11-20.csv`)
    expect(csvFilename('ワークショップ', 'ff_1', 'familiar', day)).toBe('ff_1-responses-2026-11-20.csv')
    expect(csvFilename('Q4 NPS', 'ff_1', 'detailed', new Date('2026-01-02T00:00:00Z'))).toBe('q4-nps-responses-2026-01-02-detailed.csv')
  })
})
