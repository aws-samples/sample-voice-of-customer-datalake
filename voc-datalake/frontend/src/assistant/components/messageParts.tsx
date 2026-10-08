/**
 * @fileoverview Small render pieces under an assistant message: reasoning,
 * tool-step chips, feedback / web sources, navigation chips and persona answers.
 *
 * @module assistant/components/messageParts
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Brain, CheckCircle2, ChevronDown, ChevronRight, Globe, Loader2, MessageSquareQuote, Navigation, ShieldQuestion, XCircle,
} from 'lucide-react'
import { humanizeToolName } from './messageHelpers'
import type { PersonaResponse } from './messageHelpers'
import type { ToolCall } from '@ag-ui/core'
import type { Tone } from '../../theme/tones'
import type { MessageSources, NavigationSuggestion, ToolCallStatus } from '../thread/types'

export function ReasoningBlock({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] font-medium text-aim transition-colors hover:bg-aim-subtle"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <Brain size={12} aria-hidden />
        {t('message.reasoning')}
      </button>
      {open && <p className="mt-1 whitespace-pre-wrap rounded-r-md border-l-2 border-aim/30 bg-aim-subtle/40 py-1 pl-2 pr-2 text-[12px] text-muted animate-rise">{text}</p>}
    </div>
  )
}

/** Tool-step chip tone by meaning (src/theme/tones.ts). */
const STATUS_TONES: Record<ToolCallStatus, Tone> = {
  streaming: 'muted',
  running: 'accent',
  complete: 'muted',
  awaiting_approval: 'warn',
  executed: 'ok',
  failed: 'danger',
  declined: 'muted',
  cancelled: 'muted',
}

function StatusIcon({ status }: Readonly<{ status: ToolCallStatus }>) {
  if (status === 'streaming' || status === 'running') return <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
  if (status === 'awaiting_approval') return <ShieldQuestion size={12} aria-hidden />
  if (status === 'failed' || status === 'cancelled' || status === 'declined') return <XCircle size={12} aria-hidden />
  return <CheckCircle2 size={12} aria-hidden />
}

export function ToolSteps({ calls, statuses }: Readonly<{ calls: readonly ToolCall[]; statuses: Readonly<Record<string, ToolCallStatus>> }>) {
  const { t } = useTranslation('assistant')
  if (calls.length === 0) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t('message.toolSteps')}>
      {calls.map((call) => {
        const status = statuses[call.id] ?? 'complete'
        return (
          <li
            key={call.id}
            className={`badge badge-${STATUS_TONES[status]}`}
          >
            <StatusIcon status={status} />
            <span>{humanizeToolName(call.function.name)}</span>
            <span className="sr-only">{t(`toolStatus.${status}`)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** More cards than this crowd the bubble; the answer cites the rest. */
const MAX_FEEDBACK_CARDS = 6

export function SourcesBlock({ sources }: Readonly<{ sources: MessageSources }>) {
  const { t } = useTranslation('assistant')
  if (sources.feedback.length === 0 && sources.web.length === 0) return null
  return (
    <div className="mt-2 space-y-2">
      {sources.feedback.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-medium text-muted">{t('message.feedbackSources')}</p>
          <ul className="grid gap-1.5">
            {sources.feedback.slice(0, MAX_FEEDBACK_CARDS).map((item) => (
              <li key={item.feedback_id}>
                <Link
                  to={`/feedback/${encodeURIComponent(item.feedback_id)}`}
                  className="card block p-2.5 text-[12px] hover:border-border-strong hover:bg-bg-hover"
                >
                  <span className="line-clamp-2 text-text">{item.text ?? item.feedback_id}</span>
                  <span className="mt-0.5 block text-muted">
                    {[item.source_platform, item.sentiment_label].filter(Boolean).join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sources.web.length > 0 && (
        <div className="rounded-lg border border-info/30 bg-info-subtle p-2">
          <p className="mb-1 flex items-center gap-1 text-[12px] font-medium text-info">
            <Globe size={12} aria-hidden />
            {t('message.webSources')}
          </p>
          <ul className="space-y-0.5">
            {sources.web.map((source) => (
              <li key={source.url} className="truncate text-[12px]">
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="link">
                  {source.title === '' ? source.url : source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function NavigationChips({ items }: Readonly<{ items: readonly NavigationSuggestion[] }>) {
  const navigate = useNavigate()
  if (items.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <button
          key={`${item.path}-${item.label}`}
          type="button"
          onClick={() => {
            void navigate(item.path)
          }}
          className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-subtle px-2.5 py-1 text-[12px] font-medium text-accent-text transition-colors hover:border-accent/60 active:scale-[0.97]"
        >
          <Navigation size={12} aria-hidden />
          {item.label}
        </button>
      ))}
    </div>
  )
}

function isSafeAvatar(url: string | undefined): url is string {
  return url !== undefined && (/^https:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//')))
}

export function PersonaAnswers({ responses }: Readonly<{ responses: readonly PersonaResponse[] }>) {
  const { t } = useTranslation('assistant')
  if (responses.length === 0) return null
  return (
    <ul className="mb-2 space-y-2" aria-label={t('message.personaAnswers')}>
      {responses.map((r) => (
        <li key={r.persona_id} className="card flex gap-2.5 p-3">
          {isSafeAvatar(r.avatar_url)
            ? <img src={r.avatar_url} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
            : (
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent-text">
                <MessageSquareQuote size={16} aria-hidden />
              </span>
            )}
          <div className="min-w-0 text-sm">
            <p className="font-medium text-text-strong">{r.name}</p>
            <p className="whitespace-pre-wrap text-text">{r.answer}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
