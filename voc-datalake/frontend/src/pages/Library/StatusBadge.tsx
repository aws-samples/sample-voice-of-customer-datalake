/**
 * @fileoverview A library item's status as a badge: waiting for its file, being read, ready, or failed (the failure's
 * reason is the item's own `error`, shown beside it by the row and the drawer). An item the server reads as `stale`
 * (an upload whose link expired, an extraction that outlived its worker) is stopped: no spinner, nothing moves on.
 *
 * @module pages/Library/StatusBadge
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, CircleSlash, Clock, Loader2 } from 'lucide-react'
import type { LibraryStatus } from '../../api/librarySchema'

export default function StatusBadge({ status, stale = false }: Readonly<{ status: LibraryStatus; stale?: boolean }>) {
  const { t } = useTranslation('library')
  if (stale && (status === 'pending' || status === 'extracting')) {
    return <span className="badge badge-warn"><CircleSlash size={12} aria-hidden="true" />{t('status.stale')}</span>
  }
  switch (status) {
    case 'pending':
      return <span className="badge badge-muted"><Clock size={12} aria-hidden="true" />{t('status.pending')}</span>
    case 'extracting':
      return <span className="badge badge-info"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('status.extracting')}</span>
    case 'ready':
      return <span className="badge badge-ok"><CheckCircle2 size={12} aria-hidden="true" />{t('status.ready')}</span>
    case 'failed':
      return <span className="badge badge-danger"><AlertCircle size={12} aria-hidden="true" />{t('status.failed')}</span>
  }
}
