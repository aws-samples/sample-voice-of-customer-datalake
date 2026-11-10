/**
 * @fileoverview The asks for feedback that were sent, newest first, each with its counts
 * and status; one opens its recipients. Used by Participants → Asks (every ask the caller
 * may see) and by a project's Participants tab (that project's asks).
 * @module pages/Participants/AsksList
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { Ask } from '../../api/participantsSchema'
import { formatDateTime } from '../../utils/dateUtils'
import AskDetailModal from './AskDetailModal'
import { AskStatusBadge } from './ParticipantBadges'

function AskRow({ ask, onOpen }: Readonly<{ ask: Ask; onOpen: () => void }>) {
  const { t, i18n } = useTranslation('participants')
  const { counts } = ask
  return (
    <li className="card flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1">
        <button type="button" onClick={onOpen} className="link text-left text-sm font-semibold break-words">
          {ask.subject}
        </button>
        <p className="text-xs text-muted break-words">
          {formatDateTime(ask.created_at, i18n.language)}
        </p>
        <p className="text-xs text-text">
          {t('asks.summary', {
            sent: counts.sent, failed: counts.failed, skipped: counts.skipped, responded: counts.responded, recipients: counts.recipients,
          })}
        </p>
      </div>
      <AskStatusBadge status={ask.status} />
    </li>
  )
}

export default function AsksList({ projectId = '' }: Readonly<{ projectId?: string }>) {
  const { t } = useTranslation('participants')
  const [openId, setOpenId] = useState<string | null>(null)
  const asks = useQuery({ queryKey: participantsKeys.asks(projectId), queryFn: () => participantsApi.getAsks(projectId) })

  if (asks.isPending) return <p role="status" className="text-sm text-muted">{t('loading')}</p>
  if (asks.isError) return <LoadFailed onRetry={() => void asks.refetch()} retrying={asks.isFetching} message={t('asks.loadFailed')} />
  return (
    <>
      {asks.data.length === 0 ? <p className="card text-sm text-muted">{t('asks.empty')}</p> : (
        <ul className="space-y-2" aria-label={t('tabs.asks')}>
          {asks.data.map((ask) => <AskRow key={ask.ask_id} ask={ask} onOpen={() => setOpenId(ask.ask_id)} />)}
        </ul>
      )}
      {openId === null ? null : <AskDetailModal askId={openId} onClose={() => setOpenId(null)} />}
    </>
  )
}
