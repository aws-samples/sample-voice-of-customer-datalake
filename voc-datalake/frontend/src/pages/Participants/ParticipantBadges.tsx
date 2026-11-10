/**
 * @fileoverview The small status words of the participants pages: a list's kind, a
 * person's status, an ask's status and one recipient's status.
 *
 * Every key is written out literally (i18n-check reads keys verbatim, so a key assembled
 * from a variable would read as unused and become a deletion candidate).
 *
 * @module pages/Participants/ParticipantBadges
 */
import { useTranslation } from 'react-i18next'
import type { AskStatus, ListKind, PersonStatus, RecipientStatus } from '../../api/participantsSchema'
import { kindLabel } from './kindLabel'

type Translate = (key: string) => string

export function KindBadge({ kind }: Readonly<{ kind: ListKind }>) {
  const { t } = useTranslation('participants')
  return <span className="badge badge-accent">{kindLabel(kind, t)}</span>
}

export function PersonStatusBadge({ status }: Readonly<{ status: PersonStatus }>) {
  const { t } = useTranslation('participants')
  return status === 'active'
    ? <span className="badge badge-ok">{t('personStatus.active')}</span>
    : <span className="badge badge-muted">{t('personStatus.unsubscribed')}</span>
}

const ASK_TONE: Readonly<Record<AskStatus, string>> = {
  queued: 'badge badge-muted', sending: 'badge badge-info', sent: 'badge badge-ok', failed: 'badge badge-danger',
}

function askStatusLabel(status: AskStatus, t: Translate): string {
  switch (status) {
    case 'queued': return t('askStatus.queued')
    case 'sending': return t('askStatus.sending')
    case 'sent': return t('askStatus.sent')
    case 'failed': return t('askStatus.failed')
  }
}

export function AskStatusBadge({ status }: Readonly<{ status: AskStatus }>) {
  const { t } = useTranslation('participants')
  return <span className={ASK_TONE[status]}>{askStatusLabel(status, t)}</span>
}

const RECIPIENT_TONE: Readonly<Record<RecipientStatus, string>> = {
  queued: 'badge badge-muted', sent: 'badge badge-info', failed: 'badge badge-danger',
  skipped_unsubscribed: 'badge badge-warn', responded: 'badge badge-ok',
}

function recipientStatusLabel(status: RecipientStatus, t: Translate): string {
  switch (status) {
    case 'queued': return t('recipientStatus.queued')
    case 'sent': return t('recipientStatus.sent')
    case 'failed': return t('recipientStatus.failed')
    case 'skipped_unsubscribed': return t('recipientStatus.skipped_unsubscribed')
    case 'responded': return t('recipientStatus.responded')
  }
}

export function RecipientStatusBadge({ status }: Readonly<{ status: RecipientStatus }>) {
  const { t } = useTranslation('participants')
  return <span className={RECIPIENT_TONE[status]}>{recipientStatusLabel(status, t)}</span>
}
