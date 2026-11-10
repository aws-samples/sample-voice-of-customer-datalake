/**
 * @fileoverview The visible note under the Dashboard's tiles when the window
 * was read only in part.
 *
 * The tiles mark such counts with `~` and a hover title, but a title is not
 * visible on touch, nor to most keyboard users, and "~297" next to an
 * all-time "17,067" on the other date basis reads as a bug. This note says, in
 * text, which range the counts cover (`scanned_through`) and why — reading by
 * review date counts reviews one by one, so a wide window is cut short.
 *
 * @module pages/Dashboard/PartialCountsNote
 */
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { readPartialWindow } from '../../api/partialWindow'
import type { DateBasis, MetricsSummary } from '../../api/types'
import { partialHintText } from './dashboardData'

interface PartialCountsNoteProps {
  readonly summary: MetricsSummary | undefined
  readonly dateBasis: DateBasis
}

export default function PartialCountsNote({ summary, dateBasis }: PartialCountsNoteProps) {
  const { t } = useTranslation(['dashboard', 'common'])
  const { isPartial, scannedThrough } = readPartialWindow(summary)
  const hint = partialHintText(isPartial, scannedThrough, t)
  if (hint === undefined) return null
  return (
    <p role="status" data-testid="partial-counts-note" className="flex items-start gap-2 rounded-lg border border-border bg-bg-hover px-3 py-2 text-sm text-muted">
      <Info size={16} className="mt-0.5 flex-shrink-0 text-warn" aria-hidden="true" />
      <span>
        {hint}
        {dateBasis === 'review' ? ` ${t('dashboard:partialNote.reviewBasis')}` : null}
      </span>
    </p>
  )
}
