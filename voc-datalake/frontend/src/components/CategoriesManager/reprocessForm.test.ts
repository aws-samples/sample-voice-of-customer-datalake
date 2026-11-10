/**
 * The reprocess form → request body: days XOR a date range, bounded lists (the server's rules,
 * lambda/shared/reprocess_slices.py, checked here first so Start stays disabled).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_SLICE_VALUES } from '../../api/reprocessApi'
import { buildStart, parseList } from './reprocessForm'
import type { ReprocessForm } from './reprocessForm'

const FORM: ReprocessForm = {
  mode: 'processed', includeManual: false, windowKind: 'days', daysInput: '30',
  dateFrom: '', dateTo: '', dateBasis: 'processed', sources: [], categoriesInput: '',
}

describe('buildStart', () => {
  it('sends days alone for a days window', () => {
    expect(buildStart(FORM)).toStrictEqual({ mode: 'processed', include_manual: false, days: 30 })
  })

  it('refuses an unreadable day count', () => {
    expect(buildStart({ ...FORM, daysInput: 'abc' })).toBeNull()
  })

  it('sends a range with its basis and never days', () => {
    expect(buildStart({ ...FORM, windowKind: 'range', dateFrom: '2026-02-01', dateBasis: 'review' })).toStrictEqual({
      mode: 'processed', include_manual: false, date_from: '2026-02-01', date_basis: 'review',
    })
  })

  it.each([
    ['empty', '', ''],
    ['inverted', '2026-03-01', '2026-02-01'],
    ['malformed', '01/02/2026', ''],
  ])('refuses an %s range', (_name, dateFrom, dateTo) => {
    expect(buildStart({ ...FORM, windowKind: 'range', dateFrom, dateTo })).toBeNull()
  })

  it('adds the sources and the categories only when set', () => {
    expect(buildStart({ ...FORM, sources: ['web'], categoriesInput: ' billing, ,billing , delivery' })).toStrictEqual({
      mode: 'processed', include_manual: false, sources: ['web'], categories: ['billing', 'delivery'], days: 30,
    })
  })

  it('refuses more values than the server takes', () => {
    const many = Array.from({ length: MAX_SLICE_VALUES + 1 }, (_, i) => `c${i}`).join(',')
    expect(buildStart({ ...FORM, categoriesInput: many })).toBeNull()
  })
})

describe('parseList', () => {
  it('trims, drops blanks and duplicates', () => {
    expect(parseList(' a, b ,, a ')).toStrictEqual(['a', 'b'])
  })
})

describe('MAX_SLICE_VALUES', () => {
  it('equals the backend bound', () => {
    const source = readFileSync(join(__dirname, '../../../../lambda/shared/reprocess_slices.py'), 'utf8')
    const match = /^MAX_SLICE_VALUES: Final = (\d+)$/m.exec(source)
    expect(Number(match?.[1])).toBe(MAX_SLICE_VALUES)
  })
})
