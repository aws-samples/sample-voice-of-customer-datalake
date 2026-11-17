/**
 * @fileoverview The thread's composer (7.51.00): a person's steering, sent to the run's ORCHESTRATOR
 * (`POST …/steer {text, about?}`), never to an agent: the orchestrator decides and relays it to the agents concerned,
 * fenced below the platform rules (docs/autonomous-engineering.md, "Steering"). On an agent's thread it is "about" that
 * agent unless the person unticks it, and its placeholder says where it goes. Send is the primary button only in the
 * session in focus (a grid of four shows one). Enter sends, Shift+Enter starts a line;
 * the steering with its "About <agent>: " is at most 1 KB, as the server counts it. Where the deployment does not
 * connect the Agents API to the runtime and the bus (`connected` false: steering goes over the bus), it is shown off,
 * saying why, so an admin is never left with a Send that answers 503.
 *
 * @module pages/Agents/RunWorkspace/SteerComposer
 */
import { useId, useState } from 'react'
import { Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MAX_ANSWER_BYTES } from '../../../api/engineeringRunsApi'
import { formatTime } from '../../../utils/dateUtils'
import { useActionError } from '../engineeringRunText'
import { useSteer } from './useRunWorkspace'
import type { KeyboardEvent } from 'react'

/** The bytes of the steering as the conversation keeps it (the run monitor's record): the agent it is about first. */
function steeringBytes(text: string, about: string | null): number {
  return new TextEncoder().encode(about === null ? text.trim() : `About ${about}: ${text.trim()}`).length
}

interface Props {
  runId: string
  /** The agent whose thread is open (null: the orchestrator's own). */
  agent: string | null
  /** The session in focus: Send is the primary button there, and secondary in every other session of a grid. */
  primary: boolean
  /** The deployment connects the Agents API to the runtime and the bus (the overview's `actions_available`). */
  connected: boolean
}

export function SteerComposer({ runId, agent, primary, connected }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const fieldId = useId()
  const whyId = useId()
  const steer = useSteer(runId)
  const [text, setText] = useState('')
  const [aboutAgent, setAboutAgent] = useState(true)
  const about = agent !== null && aboutAgent ? agent : null
  const used = steeringBytes(text, about)
  const tooLong = used > MAX_ANSWER_BYTES
  // (nothing to send, too long, one under way, or a deployment that cannot carry it)
  const held = !connected || text.trim() === '' || tooLong || steer.isPending
  const send = () => {
    if (held) return
    steer.mutate({ text: text.trim(), ...(about === null ? {} : { about }) }, { onSuccess: () => setText('') })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }
  return (
    <form className="space-y-1 border-t border-border p-2" onSubmit={(event) => { event.preventDefault(); send() }}>
      <label htmlFor={fieldId} className="sr-only">{t('runWorkspace.composer.label')}</label>
      <div className="flex items-end gap-2">
        <textarea id={fieldId} rows={2} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
          placeholder={about === null ? t('runWorkspace.composer.placeholder') : t('runWorkspace.composer.placeholderAbout', { agent: about })}
          className="input min-h-[2.5rem] flex-1 resize-y text-[13px]" aria-invalid={tooLong} disabled={!connected}
          aria-describedby={connected ? undefined : whyId} />
        <button type="submit" className={primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} disabled={held}
          aria-label={t('runWorkspace.composer.send')}>
          <Send size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {agent !== null && (
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={aboutAgent} onChange={(event) => setAboutAgent(event.target.checked)} />
            {t('runWorkspace.composer.about', { agent })}
          </label>
        )}
        <span className={tooLong ? 'text-danger' : undefined}>{t('engineeringRun.bytes', { used, max: MAX_ANSWER_BYTES })}</span>
        <span>{t('runWorkspace.composer.hint')}</span>
      </div>
      {!connected && <p id={whyId} className="text-[12px] text-muted">{t('runWorkspace.composer.unavailable')}</p>}
      <SteerOutcome steer={steer} />
    </form>
  )
}

/** Why the steering was refused, or when it was sent. */
function SteerOutcome({ steer }: Readonly<{ steer: ReturnType<typeof useSteer> }>) {
  const { t, i18n } = useTranslation('agents')
  const errorText = useActionError()
  if (steer.isError) return <p role="alert" className="text-[12px] text-danger">{errorText(steer.error)}</p>
  if (!steer.isSuccess) return null
  return (
    <p role="status" className="text-[12px] text-muted">
      {t('runWorkspace.composer.sent')} <time dateTime={steer.data}>{formatTime(steer.data, i18n.language)}</time>
    </p>
  )
}
