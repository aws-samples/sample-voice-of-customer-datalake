/**
 * @fileoverview The run monitor's Conversation panel: the run's messages in order (from → to, type, summary, time),
 * and for an admin a composer that answers the run's conductor or one of its agents (`POST …/messages`), on the
 * thread of the message they reply to, or on a new one.
 *
 * @module pages/Agents/EngineeringConversation
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../utils/dateUtils'
import { MAX_ANSWER_BYTES } from '../../api/engineeringRunsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { EnumSelectField } from '../../components/LabeledField/EnumSelectField'
import { useEngineeringAnswer } from './useEngineeringRun'
import { useActionError } from './engineeringRunText'
import type { AnswerRequest, ConversationMessage, EngineeringAgent } from '../../api/engineeringRunsApi'

/** Whom an answer goes to: the conductor, or an agent by id; with the thread it answers, when it answers one. */
interface Addressee {
  to: string
  threadId?: string
}

const CONDUCTOR = 'conductor'
const bytes = (text: string) => new TextEncoder().encode(text.trim()).length

/** A message a person can reply to: one an agent or the conductor sent. */
function replyTo(message: ConversationMessage): Addressee | null {
  const { from, thread_id: threadId } = message.message
  if (from.kind === 'conductor') return { to: CONDUCTOR, threadId }
  return from.kind === 'agent' ? { to: from.id, threadId } : null
}

function MessageItem({ item, onReply }: Readonly<{ item: ConversationMessage; onReply?: (to: Addressee) => void }>) {
  const { t, i18n } = useTranslation('agents')
  const { from, to, summary } = item.message
  const reply = replyTo(item)
  return (
    <li className="space-y-0.5 border-b border-border pb-2 last:border-b-0 min-w-0">
      <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        <span className="font-mono break-all">{t('engineeringRun.fromTo', { from: from.id || from.kind, to: to.id || to.kind })}</span>
        <span className="badge badge-muted">{item.type}</span>
        <time dateTime={item.at}>{formatDateTime(item.at, i18n.language, '—')}</time>
      </p>
      <p className="text-sm text-text break-words whitespace-pre-wrap">{summary}</p>
      {onReply !== undefined && reply !== null && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReply(reply)}
          aria-label={t('engineeringRun.replyTo', { who: from.id })}>
          {t('engineeringRun.reply')}
        </button>
      )}
    </li>
  )
}

function Composer({ runId, agents, addressee, onAddressee }: Readonly<{
  runId: string; agents: readonly EngineeringAgent[]; addressee: Addressee; onAddressee: (next: Addressee) => void
}>) {
  const { t } = useTranslation('agents')
  const answer = useEngineeringAnswer(runId)
  const errorText = useActionError()
  const [text, setText] = useState('')
  const countId = useId()
  const used = bytes(text)
  const tooLong = used > MAX_ANSWER_BYTES
  const send = () => {
    const target: Pick<AnswerRequest, 'to' | 'agent'> = addressee.to === CONDUCTOR ? { to: 'conductor' } : { to: 'agent', agent: addressee.to }
    answer.mutate({ ...target, text: text.trim(), ...(addressee.threadId === undefined ? {} : { thread_id: addressee.threadId }) },
      { onSuccess: () => { setText(''); onAddressee({ to: addressee.to }) } })
  }
  return (
    <form className="space-y-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); send() }}>
      <EnumSelectField label={t('engineeringRun.answerTo')} choices={[CONDUCTOR, ...agents.map((agent) => agent.agent)]}
        value={addressee.to} display={(to) => (to === CONDUCTOR ? t('engineeringRun.conductor') : to)}
        onChange={(to) => onAddressee({ to })} />
      {addressee.threadId !== undefined && (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {t('engineeringRun.replyingIn', { thread: addressee.threadId })}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAddressee({ to: addressee.to })}>
            {t('engineeringRun.newThread')}
          </button>
        </p>
      )}
      <LabeledField label={t('engineeringRun.answer')}>
        {(id) => (
          <textarea id={id} rows={3} className="input w-full resize-y" value={text} aria-invalid={tooLong}
            aria-describedby={countId} onChange={(e) => setText(e.target.value)} />
        )}
      </LabeledField>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={countId} className={tooLong ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
          {t('engineeringRun.bytes', { used, max: MAX_ANSWER_BYTES })}
        </span>
        <button type="submit" className="btn btn-primary btn-sm" disabled={used === 0 || tooLong || answer.isPending}>
          {t('engineeringRun.send')}
        </button>
      </div>
      {answer.isError && <p role="alert" className="text-[12px] text-danger">{errorText(answer.error)}</p>}
    </form>
  )
}

export function ConversationPanel({ runId, messages, agents, isAdmin, live }: Readonly<{
  runId: string; messages: readonly ConversationMessage[]; agents: readonly EngineeringAgent[]; isAdmin: boolean; live: boolean
}>) {
  const { t } = useTranslation('agents')
  const [addressee, setAddressee] = useState<Addressee>({ to: CONDUCTOR })
  const canAnswer = isAdmin && live
  return (
    <div className="space-y-3">
      {messages.length === 0
        ? <p className="text-sm text-muted">{t('engineeringRun.noMessages')}</p>
        : (
          <ol className="space-y-2" aria-label={t('engineeringRun.tabs.conversation')}>
            {messages.map((item) => <MessageItem key={item.seq} item={item} onReply={canAnswer ? setAddressee : undefined} />)}
          </ol>
        )}
      {canAnswer && <Composer runId={runId} agents={agents} addressee={addressee} onAddressee={setAddressee} />}
    </div>
  )
}
