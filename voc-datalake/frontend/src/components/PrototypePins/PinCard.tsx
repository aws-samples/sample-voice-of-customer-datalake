/**
 * @fileoverview One tester pin in the review panel: comment, anchor, console errors,
 * reply thread and resolve / reopen.
 * @module components/PrototypePins/PinCard
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, RotateCcw, Send, ShieldAlert } from 'lucide-react'
import type { PrototypePin } from '../../api/prototypePinsApi'

/** Mirrors MAX_REPLY_CHARS in lambda/shared/prototype_pins.py. */
const MAX_REPLY_CHARS = 2000

const STATUS_BADGE: Record<PrototypePin['status'], string> = {
  open: 'badge badge-warn',
  addressed: 'badge badge-info',
  resolved: 'badge badge-ok',
}

interface PinCardProps {
  readonly pin: PrototypePin
  readonly number: number
  readonly busy: boolean
  readonly onReply: (text: string) => Promise<unknown>
  readonly onStatus: (action: 'resolve' | 'reopen') => void
}

function PinAnchor({ pin }: { readonly pin: PrototypePin }) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="text-xs text-muted space-y-0.5">
      {pin.anchor.selector ? <code className="block truncate" title={pin.anchor.selector}>{pin.anchor.selector}</code> : null}
      {pin.anchor.text_snippet ? <p className="truncate">“{pin.anchor.text_snippet}”</p> : null}
      {pin.console.length > 0 ? <p className="text-danger">{t('prototypePins.consoleErrors', { count: pin.console.length })}</p> : null}
      {pin.addressed_by ? <p>{t('prototypePins.addressedBy', { id: pin.addressed_by })}</p> : null}
    </div>
  )
}

function ReplyBox({ busy, onReply }: Pick<PinCardProps, 'busy' | 'onReply'>) {
  const { t } = useTranslation('projectDetail')
  const [text, setText] = useState('')
  const inputId = useId()
  const send = () => {
    const value = text.trim()
    if (value === '') return
    void onReply(value).then(() => setText(''), () => undefined)
  }
  return (
    <div className="flex gap-1.5">
      <label htmlFor={inputId} className="sr-only">{t('prototypePins.reply')}</label>
      <input
        id={inputId}
        className="input text-xs flex-1"
        value={text}
        maxLength={MAX_REPLY_CHARS}
        placeholder={t('prototypePins.replyPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') send() }}
        disabled={busy}
      />
      <button type="button" className="btn btn-secondary btn-sm" onClick={send} disabled={busy || text.trim() === ''}
        aria-label={t('prototypePins.reply')}>
        <Send size={12} />
      </button>
    </div>
  )
}

export default function PinCard({ pin, number, busy, onReply, onStatus }: PinCardProps) {
  const { t } = useTranslation('projectDetail')
  const resolved = pin.status === 'resolved'
  return (
    <li className="card p-3 space-y-2" data-testid={`pin-${pin.pin_id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">{t('prototypePins.pinNumber', { number })}</span>
        <span className={STATUS_BADGE[pin.status]}>{t(`prototypePins.status.${pin.status}`)}</span>
        {pin.flagged ? (
          <span className="badge badge-danger inline-flex items-center gap-1"><ShieldAlert size={10} /> {t('prototypePins.flagged')}</span>
        ) : null}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{pin.comment}</p>
      <PinAnchor pin={pin} />
      {pin.replies.length > 0 ? (
        <ul className="space-y-1 border-l pl-2">
          {pin.replies.map((reply) => (
            <li key={`${reply.at}-${reply.by}`} className="text-xs">
              <span className="font-medium">{reply.name}</span> <span className="whitespace-pre-wrap break-words">{reply.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <ReplyBox busy={busy} onReply={onReply} />
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
        onClick={() => onStatus(resolved ? 'reopen' : 'resolve')}>
        {resolved ? <RotateCcw size={12} /> : <CheckCircle2 size={12} />}
        {resolved ? t('prototypePins.reopen') : t('prototypePins.resolve')}
      </button>
    </li>
  )
}
