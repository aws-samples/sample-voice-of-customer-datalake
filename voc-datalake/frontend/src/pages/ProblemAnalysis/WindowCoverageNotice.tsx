/**
 * @fileoverview Coverage caveat for the Problem Analysis stat row.
 *
 * Renders nothing when the window was read in full — a complete count needs no
 * caveat. While pages are still arriving it reports progress; when the walk
 * stopped short it says the counts undercount (U5b).
 *
 * Its own file for a mechanical reason worth knowing: `scripts/i18n-check.mjs`
 * derives **one** namespace per file from the *first* translation-hook call it
 * finds (`content.match`, not `matchAll`), and its regex reads comments too —
 * so this docblock deliberately avoids spelling such a call out. Because
 * `ProblemAnalysis.tsx` opens with the `common` namespace, a `problemAnalysis`
 * key used there is invisible to the gate no matter what the local variable is
 * named. Keeping this notice in a file whose only namespace is
 * `problemAnalysis` keeps its keys checkable.
 *
 * @module pages/ProblemAnalysis/WindowCoverageNotice
 */

import { useTranslation } from 'react-i18next'

interface WindowCoverageNoticeProps {
  /** A later page is in flight; the counts are still climbing. */
  readonly isLoadingMore: boolean
  /** Rows in the window were left unread, so the counts undercount. */
  readonly isPartial: boolean
  readonly loadedCount: number
  readonly totalCount: number
}

export function WindowCoverageNotice({
  isLoadingMore,
  isPartial,
  loadedCount,
  totalCount,
}: WindowCoverageNoticeProps) {
  const { t } = useTranslation('problemAnalysis')

  if (!isLoadingMore && !isPartial) return null

  const counts = { loaded: loadedCount, total: totalCount }
  return (
    // `text-gray-600`, not a lighter grey: this carries information, so it
    // needs the audited contrast ratio.
    <p className="text-xs text-gray-600" role="status">
      {isLoadingMore ? t('stats.loadingWindow', counts) : t('stats.partialWindow', counts)}
    </p>
  )
}
