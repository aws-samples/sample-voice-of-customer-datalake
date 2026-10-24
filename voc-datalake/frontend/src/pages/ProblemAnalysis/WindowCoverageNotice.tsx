/**
 * @fileoverview Coverage caveat for the Problem Analysis stat row.
 *
 * The server aggregates the whole window (`GET /feedback/problems`), so this renders
 * nothing unless the server says otherwise: the read stopped early (`isPartial`, with
 * the oldest day read in full when known), or only the largest problems are listed
 * (the counts still cover them all). A failed read says so, with Retry.
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
import { formatDate } from '../../utils/dateUtils'

interface WindowCoverageNoticeProps {
  /** The server could not read the whole window, so the counts undercount. */
  readonly isPartial: boolean
  /** The read failed: nothing is known about the window. */
  readonly hasFailed: boolean
  /** The oldest day the server read in full, when its read stopped early. */
  readonly scannedThrough?: string | null
  /** Set when only the largest problems are listed: how many, of how many. */
  readonly truncated?: { readonly listed: number; readonly total: number }
  /**
   * Retries the read. Required whenever `hasFailed` can be true, because the
   * failure message tells the user to retry — an instruction with no control
   * behind it is worse than no instruction.
   */
  readonly onRetry?: () => void
}

function FailedNotice({ onRetry }: Readonly<{ onRetry?: () => void }>) {
  const { t } = useTranslation('problemAnalysis')
  return (
    // No alignment of its own: the caller centres this in the empty page.
    <div role="alert">
      <p className="text-xs text-text">{t('stats.loadFailed')}</p>
      {onRetry && (
        // `type="button"` is load-bearing: the default is `submit`, which
        // would post any form this notice were ever nested in.
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-accent-text hover:text-accent underline"
        >
          {t('stats.retry')}
        </button>
      )}
    </div>
  )
}

export function WindowCoverageNotice({ isPartial, hasFailed, scannedThrough, truncated, onRetry }: WindowCoverageNoticeProps) {
  const { t, i18n } = useTranslation('problemAnalysis')
  if (hasFailed) return <FailedNotice onRetry={onRetry} />

  // `text-text` (body text), not `text-muted`: these carry information, so they
  // need the audited contrast ratio on both themes.
  const lines: string[] = []
  if (isPartial) {
    lines.push(scannedThrough
      ? t('stats.partialThrough', { date: formatDate(scannedThrough, i18n.language, scannedThrough) })
      : t('stats.partialCapped'))
  }
  if (truncated) lines.push(t('stats.problemsTruncated', truncated))
  if (lines.length === 0) return null
  return (
    <div role="status" className="space-y-1">
      {lines.map((line) => <p key={line} className="text-xs text-text">{line}</p>)}
    </div>
  )
}
