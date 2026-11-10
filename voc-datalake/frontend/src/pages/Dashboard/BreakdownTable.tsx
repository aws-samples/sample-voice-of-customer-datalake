/**
 * @fileoverview Breakdown table component for PDF export.
 * @module pages/Dashboard/BreakdownTable
 */

import type { LucideIcon } from 'lucide-react'
import { PdfIcon, PdfShareTable } from '../../components/PdfParts/pdfParts'

interface BreakdownEntry {
  readonly name: string
  readonly value: number
}

const LABELS = {
  name: 'Name',
  count: 'Count',
  share: 'Share',
  bar: '',
}

export function BreakdownTable({
  title, icon, entries, colorFn,
}: {
  readonly title: string
  readonly icon: LucideIcon
  readonly entries: BreakdownEntry[]
  readonly colorFn?: (name: string) => string
}) {
  const total = entries.reduce((sum, e) => sum + e.value, 0)
  const rows = entries.map((entry) => ({
    name: entry.name,
    value: entry.value,
    color: colorFn ? colorFn(entry.name) : '#8e48ff',
  }))
  return (
    <PdfShareTable
      heading={<><PdfIcon icon={icon} />{title}</>}
      labels={LABELS}
      rows={rows}
      total={total}
      variant="compact"
      containerStyle={{
        flex: '1',
        minWidth: '280px',
      }}
    />
  )
}
