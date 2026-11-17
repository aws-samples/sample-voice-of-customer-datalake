/**
 * @fileoverview One item of an agent's thread, as a Slack-like line (7.51.00; threadModel.ts says how each reads):
 * the agent's words as Markdown, its thinking collapsed (ACP's thought chunks), a tool call on ONE line (its
 * tool, whether it worked and a one-line input) that expands on click into its whole event and result (read then,
 * `…/thread/<ref>`), the harness's messages to the model folded, the conversation's messages, a person's steering
 * marked, and the run's events (gate results, findings, signals, checkpoints, a crash, the end) inline.
 *
 * Transcript text is the model's and the tools': rendered as Markdown with NO raw HTML (`skipHtml`), no images (no
 * request leaves for an address a transcript names), links opened apart with no opener or referrer, and cut to a
 * bounded length first (bridge doc S8).
 *
 * @module pages/Agents/RunWorkspace/ThreadItem
 */
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, Bot, Brain, CheckCircle2, ChevronRight, Circle, Compass, Flag, Loader2, Radio, Save, Search,
  ShieldCheck, User, Workflow, XCircle,
} from 'lucide-react'
import { formatTime } from '../../../utils/dateUtils'
import { isRecord } from '../../../lib/typeGuards'
import { boundedText, lookOf } from './threadModel'
import { useThreadItem } from './useRunWorkspace'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Components } from 'react-markdown'
import type { ThreadEvent, ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

/** The longest whole event or result shown when a tool call is opened. */
const MAX_DETAIL = 8000

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="link">{children}</a>,
}

/** Transcript text as Markdown only: no raw HTML, no images, bounded before it is parsed. */
function TranscriptMarkdown({ text }: Readonly<{ text: string }>) {
  return (
    <div className="md-content text-[13px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} unwrapDisallowed
        components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const SENDER_ICONS: Readonly<Record<string, LucideIcon>> = { agent: Bot, human: User, conductor: Workflow }

function SenderLine({ item }: Readonly<{ item: ThreadItem }>) {
  const { t, i18n } = useTranslation('agents')
  const Icon = SENDER_ICONS[item.from.kind] ?? Circle
  const name = t(`runWorkspace.thread.senders.${item.from.kind}`, { id: item.from.id, defaultValue: item.from.id })
  return (
    <p className="flex items-center gap-1.5 pt-2 text-[12px]">
      <Icon size={13} className="text-muted" aria-hidden="true" />
      <span className="font-semibold text-text-strong break-all">{name}</span>
      <time dateTime={item.at} className="text-muted">{formatTime(item.at, i18n.language)}</time>
    </p>
  )
}

function CutNote({ cut }: Readonly<{ cut: boolean }>) {
  const { t } = useTranslation('agents')
  return cut ? <p className="text-[12px] text-muted">{t('runWorkspace.thread.cut')}</p> : null
}

/** Data shown as data: a record's JSON, or a text, bounded. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
}

/** A result's own text (a tool_result record's `text`), else the record itself. */
const resultText = (result: unknown): unknown => (isRecord(result) && typeof result.text === 'string' ? result.text : result)

function ToolDetail({ detail }: Readonly<{ detail: ThreadEvent }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="mt-1 space-y-1">
      <p className="text-[12px] font-medium text-muted">{t('runWorkspace.thread.tool.event')}</p>
      <pre className="max-h-60 overflow-auto rounded-md bg-bg-accent p-2 text-[12px] whitespace-pre-wrap break-all">{shown(detail.event)}</pre>
      <p className="text-[12px] font-medium text-muted">{t('runWorkspace.thread.tool.result')}</p>
      {detail.result === null
        ? <p className="text-[12px] text-muted">{t('runWorkspace.thread.tool.noResult')}</p>
        : <pre className="max-h-60 overflow-auto rounded-md bg-bg-accent p-2 text-[12px] whitespace-pre-wrap break-all">{shown(resultText(detail.result))}</pre>}
    </div>
  )
}

function ToolStatus({ tool }: Readonly<{ tool: NonNullable<ThreadItem['tool']> }>) {
  const { t } = useTranslation('agents')
  if (tool.ok === true) return <CheckCircle2 size={13} className="shrink-0 text-ok" aria-label={t('runWorkspace.thread.tool.ok')} />
  if (tool.ok === false) return <XCircle size={13} className="shrink-0 text-danger" aria-label={t('runWorkspace.thread.tool.failed')} />
  return <Loader2 size={13} className="shrink-0 animate-spin text-accent-text" aria-label={t('runWorkspace.thread.tool.running')} />
}

/** A tool call on one line; a click opens its whole event and result (read then). */
function ToolLine({ runId, agent, item }: Readonly<{ runId: string; agent: string; item: ThreadItem }>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const tool = item.tool ?? { name: item.text, ok: null, input: '', kind: '', status: '' }
  const detail = useThreadItem(runId, agent, item.ref, tool.status, open)
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] hover:bg-bg-hover">
        <ChevronRight size={12} aria-hidden="true" className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <ToolStatus tool={tool} />
        <span className="shrink-0 font-mono font-medium text-text-strong">{tool.name}</span>
        <span className="min-w-0 truncate font-mono text-muted">{tool.input}</span>
        {tool.kind !== '' && <span className="ml-auto shrink-0 badge badge-muted">{tool.kind}</span>}
      </button>
      {open && detail.isLoading && <p className="pl-6 text-[12px] text-muted">{t('runWorkspace.loading')}</p>}
      {open && detail.isError && <p role="alert" className="pl-6 text-[12px] text-danger">{t('runWorkspace.thread.tool.loadFailed')}</p>}
      {open && detail.data !== undefined && <div className="pl-6"><ToolDetail detail={detail.data} /></div>}
    </div>
  )
}

const EVENT_ICONS: Readonly<Record<string, LucideIcon>> = {
  gate: ShieldCheck, finding: Search, signal: Radio, checkpoint: Save, crash: AlertTriangle, end: Flag,
}

function EventLine({ item }: Readonly<{ item: ThreadItem }>) {
  const { t } = useTranslation('agents')
  const Icon = EVENT_ICONS[item.kind] ?? Circle
  const { text } = boundedText(item)
  return (
    <p className={clsx('flex items-start gap-1.5 text-[12px] text-muted', item.kind === 'crash' && 'text-danger')}>
      <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{t(`runWorkspace.thread.kinds.${item.kind}`, { defaultValue: item.kind })}</span>
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{text}</span>
    </p>
  )
}

/** A disclosure for what is collapsed by default: the agent's thinking, the harness's messages to the model. */
function Folded({ icon: Icon, summary, children }: Readonly<{ icon: LucideIcon; summary: string; children: ReactNode }>) {
  return (
    <details className="text-[12px]">
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-text">
        <Icon size={13} aria-hidden="true" /> {summary}
      </summary>
      <div className="mt-1 border-l-2 border-border pl-3">{children}</div>
    </details>
  )
}

function ItemBody({ runId, agent, item }: Readonly<{ runId: string; agent: string; item: ThreadItem }>) {
  const { t } = useTranslation('agents')
  const { text, cut } = boundedText(item)
  switch (lookOf(item)) {
    case 'said':
      return <><TranscriptMarkdown text={text} /><CutNote cut={cut} /></>
    case 'thought':
      return <Folded icon={Brain} summary={t('runWorkspace.thread.thought')}><TranscriptMarkdown text={text} /><CutNote cut={cut} /></Folded>
    case 'tool':
      return <ToolLine runId={runId} agent={agent} item={item} />
    case 'folded':
      return (
        <Folded icon={Bot} summary={t('runWorkspace.thread.toModel', { id: item.from.id })}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] text-muted">{text}</pre><CutNote cut={cut} />
        </Folded>
      )
    case 'steer':
      return (
        <div className="rounded-md border-l-4 border-accent bg-accent-subtle px-3 py-1.5 text-[13px]">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-accent-text">
            <Compass size={12} aria-hidden="true" /> {t('runWorkspace.thread.steering')}
          </p>
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      )
    case 'message':
      return <p className="whitespace-pre-wrap break-words text-[13px] text-text">{text}</p>
    case 'event':
      return <EventLine item={item} />
  }
}

/** One item; `header` starts a message group (who, and when). */
export function ThreadItemView({ runId, agent, item, header }: Readonly<{
  runId: string; agent: string; item: ThreadItem; header: boolean
}>) {
  return (
    <li className="px-3 py-0.5" data-ref={item.ref}>
      {header && <SenderLine item={item} />}
      <ItemBody runId={runId} agent={agent} item={item} />
    </li>
  )
}
