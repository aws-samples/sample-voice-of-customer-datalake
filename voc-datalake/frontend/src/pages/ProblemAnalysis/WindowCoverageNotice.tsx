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
  /** A request failed. With `loadedCount` 0 this means nothing was read. */
  readonly hasFailed: boolean
  readonly loadedCount: number
  readonly totalCount: number
  /**
   * Retries the read. Required whenever `hasFailed` can be true, because the
   * failure message tells the user to retry — an instruction with no control
   * behind it is worse than no instruction.
   */
  readonly onRetry?: () => void
}

/**
 * Failure outranks everything, and nothing-was-read is a different statement
 * from some-was-read: zero rows after a failure is not an empty window, it is
 * an unknown one.
 */
export function WindowCoverageNotice({
  isLoadingMore,
  isPartial,
  hasFailed,
  loadedCount,
  totalCount,
  onRetry,
}: WindowCoverageNoticeProps) {
  const { t } = useTranslation('problemAnalysis')

  // `text-gray-600`, not a lighter grey: these carry information, so they need
  // the audited contrast ratio.
  const className = 'text-xs text-gray-600'
  const counts = { loaded: loadedCount, total: totalCount }

  if (hasFailed && loadedCount === 0) {
    return (
      <div role="alert" className="text-center">
        <p className={className}>{t('stats.loadFailed')}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline"
          >
            {t('stats.retry')}
          </button>
        )}
      </div>
    )
  }

  // Progress is deliberately NOT a live region: a full walk settles a dozen
  // times, and announcing each one talks over everything else on the page.
  // Only the terminal states below are announced.
  if (isLoadingMore) {
    return <p className={className}>{t('stats.loadingWindow', counts)}</p>
  }

  if (isPartial) {
    return (
      <p className={className} role="status">
        {t('stats.partialWindow', counts)}
      </p>
    )
  }

  return null
}
