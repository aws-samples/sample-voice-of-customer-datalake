/**
 * @fileoverview The PDF reports' status colours and table-row style, shared by
 * every report (Dashboard, Categories, Problem Analysis, persona export). Hex
 * values, because a report is rasterised outside the app stylesheet. Kept out of
 * `pdfParts.tsx` so that file exports only components (fast refresh).
 * @module components/PdfParts/pdfTones
 */
import type { CSSProperties } from 'react'

export type PdfTone = 'ok' | 'warn' | 'danger' | 'muted'

/**
 * The reports' status colours, one `{bg, color}` pair per tone: the print
 * counterparts of the app's ok / warn / danger / muted tokens (a report is
 * rasterised outside the stylesheet, so they are hex values).
 */
export const PDF_TONES = {
  ok: { bg: '#e0eee7', color: '#007038' },
  warn: { bg: '#f0eee6', color: '#6b5900' },
  danger: { bg: '#f8e8eb', color: '#bd1c3a' },
  muted: { bg: '#f5f5f5', color: '#4a464f' },
} as const satisfies Record<PdfTone, { readonly bg: string; readonly color: string }>

/** A tone as inline style: its tint behind its text colour. */
export function pdfToneStyle(tone: PdfTone): CSSProperties {
  return { backgroundColor: PDF_TONES[tone].bg, color: PDF_TONES[tone].color }
}

/** Row `i` of a report table: alternating white / grey with a hairline under it. */
export function pdfZebraRow(i: number): CSSProperties {
  return {
    borderBottom: '1px solid #f5f5f5',
    backgroundColor: i % 2 === 0 ? '#ffffff' : '#f5f5f5',
  }
}
