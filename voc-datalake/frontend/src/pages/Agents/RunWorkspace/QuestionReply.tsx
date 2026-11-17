/**
 * @fileoverview An answer to an agent's question, from its thread (7.51.00): the run monitor's Conversation panel is
 * gone, and what it did that steering does not, answering an agent on the thread its own question opened (D51-4: the
 * one message a person sends an agent, `POST …/messages {to: agent, agent, text, thread_id}`), sits under the
 * question. Anything else for an agent is steering, through the orchestrator (SteerComposer.tsx).
 *
 * @module pages/Agents/RunWorkspace/QuestionReply
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_ANSWER_BYTES } from '../../../api/engineeringRunsApi'
import { useEngineeringAnswer } from '../useEngineeringRun'
import { useActionError } from '../engineeringRunText'

const answerBytes = (text: string) => new TextEncoder().encode(text.trim()).length

export function QuestionReply({ runId, agent, threadId }: Readonly<{ runId: string; agent: string; threadId: string }>) {
  const { t } = useTranslation('agents')
  const fieldId = useId()
  const answer = useEngineeringAnswer(runId)
  const errorText = useActionError()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const used = answerBytes(text)
  const tooLong = used > MAX_ANSWER_BYTES
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label={t('engineeringRun.replyTo', { who: agent })}>
          {t('engineeringRun.reply')}
        </button>
        {answer.isSuccess && <span role="status" className="text-[12px] text-muted">{t('engineeringRun.signalSent')}</span>}
      </div>
    )
  }
  const send = () => {
    answer.mutate({ to: 'agent', agent, text: text.trim(), thread_id: threadId }, {
      onSuccess: () => {
        setText('')
        setOpen(false)
      },
    })
  }
  return (
    <form className="mt-1 space-y-1" onSubmit={(event) => { event.preventDefault(); send() }}>
      <label htmlFor={fieldId} className="block text-[12px] text-muted">{t('engineeringRun.answer')}</label>
      <textarea id={fieldId} rows={2} className="input w-full resize-y text-[13px]" value={text} aria-invalid={tooLong}
        onChange={(event) => setText(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <span className={tooLong ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>{t('engineeringRun.bytes', { used, max: MAX_ANSWER_BYTES })}</span>
        <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => setOpen(false)}>{t('common:cancel')}</button>
        <button type="submit" className="btn btn-secondary btn-sm" disabled={used === 0 || tooLong || answer.isPending}>{t('engineeringRun.send')}</button>
      </div>
      {answer.isError && <p role="alert" className="text-[12px] text-danger">{errorText(answer.error)}</p>}
    </form>
  )
}
