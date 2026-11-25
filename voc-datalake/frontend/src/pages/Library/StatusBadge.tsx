/**
 * @fileoverview A library item's status as a badge: waiting for its file, being read, ready, or failed (the failure's
 * reason is the item's own `error`, shown beside it by the row and the drawer).
 *
 * @module pages/Library/StatusBadge
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
import type { LibraryStatus } from '../../api/librarySchema'

export default function StatusBadge({ status }: Readonly<{ status: LibraryStatus }>) {
  const { t } = useTranslation('library')
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
