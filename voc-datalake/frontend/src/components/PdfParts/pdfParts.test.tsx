/**
 * @fileoverview The PDF reports' shared tone palette and table rows keep the
 * exact colours the five report files used to declare one by one, and the share
 * table writes its numbers in the report's language.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PdfShareTable } from './pdfParts'
import { PDF_TONES, pdfToneStyle, pdfZebraRow } from './pdfTones'

describe('PDF tones', () => {
  it.each([
    ['ok', '#e0eee7', '#007038'],
    ['warn', '#f0eee6', '#6b5900'],
    ['danger', '#f8e8eb', '#bd1c3a'],
    ['muted', '#f5f5f5', '#4a464f'],
  ] as const)('keeps the %s tint %s and text colour %s the reports have always printed', (tone, bg, color) => {
    expect(PDF_TONES[tone]).toStrictEqual({ bg, color })
  })

  it('has exactly those four tones', () => {
    expect(Object.keys(PDF_TONES)).toStrictEqual(['ok', 'warn', 'danger', 'muted'])
  })

  it('gives a tone as its tint behind its text colour', () => {
    expect(pdfToneStyle('danger')).toStrictEqual({ backgroundColor: '#f8e8eb', color: '#bd1c3a' })
  })

  it('alternates table rows white and grey under a hairline', () => {
    expect(pdfZebraRow(0)).toStrictEqual({ borderBottom: '1px solid #f5f5f5', backgroundColor: '#ffffff' })
    expect(pdfZebraRow(1)).toStrictEqual({ borderBottom: '1px solid #f5f5f5', backgroundColor: '#f5f5f5' })
  })
})

describe('PdfShareTable numbers', () => {
  const labels = { name: 'Name', count: 'Count', share: 'Share', bar: 'Bar' }
  const rows = [{ name: 'delivery', value: 26622, color: '#000000' }, { name: 'price', value: 3378, color: '#111111' }]

  it('groups counts and writes the share with one decimal in English by default', () => {
    render(<PdfShareTable heading="Categories" labels={labels} rows={rows} total={30000} variant="regular" />)
    expect(screen.getByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('88.7%')).toBeInTheDocument()
  })

  it('follows the locale a translated report passes', () => {
    render(<PdfShareTable heading="Kategorie" labels={labels} rows={rows} total={30000} variant="regular" locale="pl" />)
    expect(screen.getByText('26 622')).toBeInTheDocument()
    expect(screen.getByText('88,7%')).toBeInTheDocument()
  })
})
