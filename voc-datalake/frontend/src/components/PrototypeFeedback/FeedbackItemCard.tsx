/**
 * @fileoverview One feedback item: who ("Tester", or how many testers said it),
 * where (screen, element, versions), when, its status, its replies, and the
 * checkbox that selects it. A flagged item says it is not sent to the AI and
 * cannot be selected; an item that would pass the pin cap says so.
 * @module components/PrototypeFeedback/FeedbackItemCard
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ShieldAlert, Users, User } from 'lucide-react'
import type { FeedbackItem } from '../../api/prototypeFeedbackSchema'
import { PIN_STATUSES } from '../../api/prototypePinsApi'
import { formatDateTime } from '../../utils/dateUtils'
import { IconBadge } from '../IconBadge/IconBadge'
import { STATUS_BADGE } from '../PrototypePins/pinStatusBadge'
import { MAX_SELECTED_PINS, type BlockedReason } from './selection'

/** How much of the comment names the item to a screen reader on its checkbox. */
const LABEL_CHARS = 80

interface FeedbackItemCardProps {
  readonly item: FeedbackItem
  readonly checked: boolean
  readonly blocked: BlockedReason
  readonly onToggle: (checked: boolean) => void
}

function shortText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat
}

/** What a disabled checkbox says about itself, or null when it is not disabled. */
function blockedText(blocked: BlockedReason, t: TFunction<'components'>): string | null {
  if (blocked === 'flagged') return t('prototypeFeedback.notSentToAi')
  if (blocked === 'cap') return t('prototypeFeedback.capReason', { max: MAX_SELECTED_PINS })
  return null
}

function ItemWhere({ item }: { readonly item: FeedbackItem }) {
  const { t, i18n } = useTranslation('components')
  const versions = [...new Set(item.pins.map((pin) => pin.version).filter((version) => version > 0))].sort((a, b) => a - b)
  const when = formatDateTime(item.first_at, i18n.language)
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs text-muted">
      <dt>{t('prototypeFeedback.screen')}</dt>
      <dd className="text-text break-words">{item.anchor.route || t('prototypeFeedback.noScreen')}</dd>
      {item.anchor.text_snippet || item.anchor.selector ? (
        <>
          <dt>{t('prototypeFeedback.element')}</dt>
          <dd className="text-text min-w-0">
            {item.anchor.text_snippet ? <span className="break-words">“{item.anchor.text_snippet}”</span> : null}
            {item.anchor.selector ? <code className="block break-all text-muted">{item.anchor.selector}</code> : null}
          </dd>
        </>
      ) : null}
      {versions.length > 0 ? (
        <>
          <dt>{t('prototypeFeedback.versionsLabel', { count: versions.length })}</dt>
          <dd className="text-text">{versions.map((version) => t('prototypeFeedback.version', { version })).join(', ')}</dd>
        </>
      ) : null}
      {when ? (
        <>
          <dt>{t('prototypeFeedback.when')}</dt>
          <dd className="text-text"><time dateTime={item.first_at}>{when}</time></dd>
        </>
      ) : null}
    </dl>
  )
}

function ItemReplies({ item }: { readonly item: FeedbackItem }) {
  const { t } = useTranslation('components')
  const replies = item.pins.flatMap((pin) => pin.replies.map((reply, index) => ({ ...reply, key: `${pin.pin_id}-${index}` })))
  if (replies.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-strong">{t('prototypeFeedback.replies', { count: replies.length })}</p>
      <ul className="space-y-1 border-l pl-2">
        {replies.map((reply) => (
          <li key={reply.key} className="text-xs break-words">
            <span className="font-medium">{reply.name || t('prototypeFeedback.someone')}</span>{' '}
            <span className="whitespace-pre-wrap">{reply.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function FeedbackItemCard({ item, checked, blocked, onToggle }: FeedbackItemCardProps) {
  const { t } = useTranslation('components')
  // A status reads as the pins panel words it (projectDetail's prototypePins.status.*).
  const { t: tPins } = useTranslation('projectDetail')
  const checkboxId = useId()
  const reasonId = useId()
  const statuses = PIN_STATUSES.filter((status) => item.pins.some((pin) => pin.status === status))
  const reason = blockedText(blocked, t)
  const label = t('prototypeFeedback.selectItem', { text: shortText(item.text) || t('prototypeFeedback.noComment') })
  return (
    <li className="card p-3 sm:p-4 space-y-2 min-w-0" data-testid={`feedback-item-${item.item_id}`}>
      <div className="flex items-start gap-3 min-w-0">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 flex-shrink-0"
          checked={checked}
          disabled={blocked !== null}
          aria-describedby={reason === null ? undefined : reasonId}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor={checkboxId} className="sr-only">{label}</label>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-text-strong">
              {item.count > 1 ? <Users size={14} aria-hidden /> : <User size={14} aria-hidden />}
              {item.count > 1 ? t('prototypeFeedback.testersSaid', { count: item.count }) : t('prototypeFeedback.tester')}
            </span>
            {statuses.map((status) => (
              <span key={status} className={STATUS_BADGE[status]}>{tPins(`prototypePins.status.${status}`)}</span>
            ))}
            {item.flagged ? (
              <IconBadge toneClass="badge-danger" icon={ShieldAlert} iconSize={10}>{t('prototypeFeedback.flagged')}</IconBadge>
            ) : null}
          </div>
          <p className="text-sm whitespace-pre-wrap break-words">{item.text || t('prototypeFeedback.noComment')}</p>
          <ItemWhere item={item} />
          <ItemReplies item={item} />
          {reason === null ? null : (
            <p id={reasonId} className={blocked === 'flagged' ? 'text-xs text-danger' : 'text-xs text-muted'}>{reason}</p>
          )}
        </div>
      </div>
    </li>
  )
}
