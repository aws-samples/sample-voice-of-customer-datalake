/**
 * @fileoverview One ask for feedback: its message, link and per-recipient status (an
 * erased person shows as such — the row keeps only the id).
 * @module pages/Participants/AskDetailModal
 */
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { AskDetail, AskRecipient } from '../../api/participantsSchema'
import { formatDateTime } from '../../utils/dateUtils'
import AskCounts from './AskCounts'
import { AskStatusBadge, RecipientStatusBadge } from './ParticipantBadges'

/** While an ask is still going out its counts move: poll until it settles. */
const SENDING_POLL_MS = 5000

function RecipientRow({ recipient }: Readonly<{ recipient: AskRecipient }>) {
  const { t, i18n } = useTranslation('participants')
  const when = recipient.responded_at ?? recipient.sent_at
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-strong break-words">{recipient.name ?? recipient.email ?? t('asks.erasedPerson')}</p>
        {recipient.name !== null && recipient.email !== null ? <p className="text-xs text-muted break-all">{recipient.email}</p> : null}
        {recipient.error === null ? null : <p className="text-xs text-danger break-words">{t('asks.errorCode', { code: recipient.error })}</p>}
      </div>
      {when === null ? null : <span className="text-xs text-muted">{formatDateTime(when, i18n.language)}</span>}
      <RecipientStatusBadge status={recipient.status} />
    </li>
  )
}

function AskBody({ detail }: Readonly<{ detail: AskDetail }>) {
  const { t } = useTranslation('participants')
  const linkUrl = detail.ask.link?.url ?? ''
  return (
    <>
      <AskCounts counts={detail.ask.counts} />
      <p className="text-sm text-text whitespace-pre-wrap break-words">{detail.ask.message}</p>
      {linkUrl === '' ? null : <p className="text-xs text-muted break-all">{t('asks.link')}: {linkUrl}</p>}
      <section aria-label={t('asks.recipients')}>
        <h3 className="text-sm font-medium text-text">{t('asks.recipients')}</h3>
        <ul className="divide-y divide-border">
          {detail.recipients.map((recipient) => <RecipientRow key={recipient.person_id} recipient={recipient} />)}
        </ul>
      </section>
    </>
  )
}

export default function AskDetailModal({ askId, onClose }: Readonly<{ askId: string; onClose: () => void }>) {
  const { t } = useTranslation('participants')
  const titleId = useId()
  const detail = useQuery({
    queryKey: participantsKeys.ask(askId),
    queryFn: () => participantsApi.getAsk(askId),
    refetchInterval: (query) => {
      const status = query.state.data?.ask.status
      return status === 'queued' || status === 'sending' ? SENDING_POLL_MS : false
    },
  })
  const ask = detail.data?.ask

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="dialog-title break-words">{ask?.subject ?? t('asks.detailTitle')}</h2>
          {ask === undefined ? null : <AskStatusBadge status={ask.status} />}
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-4 overflow-y-auto">
        {detail.isPending ? <p role="status" className="text-sm text-muted">{t('loading')}</p> : null}
        {detail.isError ? <LoadFailed onRetry={() => void detail.refetch()} retrying={detail.isFetching} /> : null}
        {detail.data === undefined ? null : <AskBody detail={detail.data} />}
      </div>
    </ModalShell>
  )
}
