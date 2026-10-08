/**
 * @fileoverview A list that could not be loaded, said as such, with a way to try again.
 *
 * Used where a failed list read used to fall through to the page's EMPTY state
 * (Projects, Feedback Forms): offline, or on any API error, the page told the
 * user they had no projects / no forms and offered to create the first one —
 * a false statement about their data, made exactly when they cannot check it
 * (e2e network.spec.ts, P3). An alert, so it is announced; the retry refetches
 * the query and the page recovers in place once the network is back.
 *
 * @module components/LoadFailed
 */
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function LoadFailed({ onRetry, retrying = false, message }: Readonly<{
  onRetry: () => void
  /** A refetch is in flight: the button waits for it rather than stacking another. */
  retrying?: boolean
  /** What failed to load, when the page names it (else the generic `common:loadFailed.message`). */
  message?: string
}>) {
  const { t } = useTranslation('common')
  return (
    <div role="alert" className="card flex flex-col sm:flex-row sm:items-center gap-3 border-danger/30 bg-danger-subtle text-sm text-danger">
      <span className="flex flex-1 items-center gap-2">
        <AlertCircle size={16} aria-hidden="true" className="flex-shrink-0" />
        {message ?? t('loadFailed.message')}
      </span>
      <button type="button" onClick={() => onRetry()} disabled={retrying} className="btn btn-secondary btn-sm justify-center">
        <RefreshCw size={14} aria-hidden="true" className={retrying ? 'animate-spin' : undefined} />
        {t('loadFailed.retry')}
      </button>
    </div>
  )
}
