/**
 * @fileoverview A list that could not be loaded, said as such, with a way to try again.
 *
 * Used where a failed list read used to fall through to the page's EMPTY state
 * (Projects, Feedback Forms): offline, or on any API error, the page told the
 * user they had no projects / no forms and offered to create the first one —
 * a false statement about their data, made exactly when they cannot check it
 * (e2e network.spec.ts, P3). An alert, so it is announced; the retry refetches
 * the query and the page recovers in place once the network is back.
 * The danger banner of the shared Notice.
 *
 * @module components/LoadFailed
 */
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Notice from '../Notice/Notice'

export default function LoadFailed({ onRetry, retrying, message }: Readonly<{
  onRetry: () => void
  /** A refetch is in flight: the button waits for it rather than stacking another. */
  retrying: boolean
  /** What failed to load, when the page names it (else the generic `common:loadFailed.message`). */
  message?: string
}>) {
  const { t } = useTranslation('common')
  return (
    <Notice variant="banner" tone="danger" role="alert" icon={AlertCircle} text={message ?? t('loadFailed.message')}
      action={{ label: t('loadFailed.retry'), icon: RefreshCw, onClick: onRetry, busy: retrying }} />
  )
}
