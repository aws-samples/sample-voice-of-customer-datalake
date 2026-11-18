/**
 * @fileoverview One item of an agent's thread, as a Slack-like line (7.51.00; threadModel.ts says how each reads):
 * the agent's words as Markdown, its thinking collapsed (ACP's thought chunks), a tool call on ONE line (its
 * tool, whether it worked and a one-line input) that expands on click into its whole event and result (read then,
 * `…/thread/<ref>`), the harness's messages to the model folded, the conversation's messages (an agent's own question
 * with a Reply), a person's steering marked, and the run's events (gate results, findings, signals, checkpoints, a
 * crash, the end) inline; (7.51.04) the supervisor's own lines in plain words, their raw text behind "Details"
 * (SupervisorLine.tsx).
 *
 * Transcript text is the model's and the tools': rendered through the app's one safe-Markdown policy for model text
 * (7.52.00: components/Document/read/markdownPolicy.ts `model`): no raw HTML (shown as its inert source), no images
 * (no request leaves for an address a transcript names), only http(s) and in-app links (opened apart with no opener
 * or referrer), and cut to a bounded length first (bridge doc S8).
 *
 * (7.54.00) The agent's replies (its words, and what it says through report_progress, submit_work and finish, which
 * the server makes its words) are message rows under who said it and when; its thinking is a collapsed, de-emphasised
 * "Thinking…" row with its first words, shown while the Sessions pane's "Show thinking" is on (useShowThinking.ts); a
 * long text opens folded behind "Show more".
 *
 * @module pages/Agents/RunWorkspace/ThreadItem
 */
import { useId, useState } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertTriangle, Bot, Brain, CheckCircle2, ChevronRight, Circle, CircleSlash, Compass, Flag, Loader2, Radio, Save, Search,
  ShieldCheck, User, Workflow, XCircle,
} from 'lucide-react'
import MarkdownRead from '../../../components/Document/read/MarkdownRead'
import { markdownPolicy } from '../../../components/Document/read/markdownPolicy'
import { formatTime } from '../../../utils/dateUtils'
import { isRecord } from '../../../lib/typeGuards'
import { boundedText, isLongText, lookOf } from './threadModel'
import { useThreadItem } from './useRunWorkspace'
import { QuestionReply } from './QuestionReply'
import { SupervisorLineView } from './SupervisorLine'
import { isSupervisors, readSupervisorLine } from './supervisorLines'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ThreadEvent, ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

/** The longest whole event or result shown when a tool call is opened. */
const MAX_DETAIL = 8000

/** Transcript text as model text: the shared `model` policy (no raw HTML, no images), bounded before it is parsed. A
 * thread's headings take no ids: a deep link names a document's heading, never a line of a transcript. */
function TranscriptMarkdown({ text, quiet = false }: Readonly<{ text: string; quiet?: boolean }>) {
  return (
    <MarkdownRead source={text} policy={markdownPolicy.model} headingIds={false}
      className={clsx('md-content break-words', quiet ? 'md-content-quiet' : 'text-[13px]')} />
  )
}

/**
 * (7.54.00) A long text opens folded: its first lines, faded at the cut, and "Show more" (then "Show less"), which
 * says what it does to a screen reader (`aria-expanded` on the region it controls). A short one shows whole.
 */
function ShowMore({ text, children }: Readonly<{ text: string; children: ReactNode }>) {
  const { t } = useTranslation('agents')
  const regionId = useId()
  const [open, setOpen] = useState(false)
  if (!isLongText(text)) return <>{children}</>
  return (
    <div>
      <div id={regionId} data-folded={!open}
        className={clsx(!open && 'max-h-[12.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]')}>
        {children}
      </div>
      <button type="button" className="link mt-0.5 text-[12px]" aria-expanded={open} aria-controls={regionId}
        onClick={() => setOpen(!open)}>
        {open ? t('runWorkspace.thread.showLess') : t('runWorkspace.thread.showMore')}
      </button>
    </div>
  )
}

const SENDER_ICONS: Readonly<Record<string, LucideIcon>> = { agent: Bot, human: User, conductor: Workflow, supervisor: Activity }

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

/** A call's state: worked, failed, under way (a spinner), or (7.54.00) never answered because its session ended
 * first, which never spins. */
function ToolStatus({ tool, ended }: Readonly<{ tool: NonNullable<ThreadItem['tool']>; ended: boolean }>) {
  const { t } = useTranslation('agents')
  if (tool.ok === true) return <CheckCircle2 size={13} className="shrink-0 text-ok" aria-label={t('runWorkspace.thread.tool.ok')} />
  if (tool.ok === false) return <XCircle size={13} className="shrink-0 text-danger" aria-label={t('runWorkspace.thread.tool.failed')} />
  if (ended) return <CircleSlash size={13} className="shrink-0 text-muted" aria-label={t('runWorkspace.thread.tool.endedFirst')} />
  return <Loader2 size={13} className="shrink-0 animate-spin text-accent-text" aria-label={t('runWorkspace.thread.tool.running')} />
}

/** A tool call on one line; a click opens its whole event and result (read then). */
function ToolLine({ runId, agent, item, ended }: Readonly<{ runId: string; agent: string; item: ThreadItem; ended: boolean }>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const tool = item.tool ?? { name: item.text, ok: null, input: '', kind: '', status: '' }
  const detail = useThreadItem(runId, agent, item.ref, tool.status, open)
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] hover:bg-bg-hover">
        <ChevronRight size={12} aria-hidden="true" className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <ToolStatus tool={tool} ended={ended} />
        <span className="shrink-0 font-mono font-medium text-text-strong">{tool.name}</span>
        <span className="min-w-0 truncate font-mono text-muted">{tool.input}</span>
        {/* (7.54.00: a narrow pane keeps the line for the tool and its input; the kind shows from 28rem) */}
        {tool.kind !== '' && <span className="ml-auto hidden shrink-0 badge badge-muted @md:inline-flex">{tool.kind}</span>}
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

/**
 * A disclosure for what is collapsed by default: the agent's thinking (7.54.00: "Thinking…", de-emphasised, its first
 * words beside it), the harness's messages to the model. Its chevron turns as it opens.
 */
function Folded({ icon: Icon, summary, preview, children }: Readonly<{
  icon: LucideIcon; summary: string; preview?: string; children: ReactNode
}>) {
  return (
    <details className="group text-[12px]">
      <summary className="focus-ring flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 text-muted hover:bg-bg-hover hover:text-text [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
        <Icon size={13} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0">{summary}</span>
        {preview !== undefined && preview !== '' && <span className="min-w-0 truncate italic group-open:hidden">{preview}</span>}
      </summary>
      <div className="ml-2.5 mt-1 border-l-2 border-border pl-3">{children}</div>
    </details>
  )
}

/** The first line of a text, for a folded row's preview. */
const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''

/** What an item shows beside itself: every item it stands for (a run of the supervisor's same line), the run's
 * orchestrator. */
interface Context {
  said: readonly ThreadItem[]
  orchestrator: string | null
  /** (7.54.00) The thread has ended. */
  ended: boolean
}

/** A conversation message; the supervisor's in plain words where its shape is known (7.51.04). */
function MessageBody({ item, text, context }: Readonly<{ item: ThreadItem; text: string; context: Context }>) {
  const line = isSupervisors(item) ? readSupervisorLine(item.text) : null
  if (line !== null) return <SupervisorLineView line={line} said={context.said} orchestrator={context.orchestrator} />
  return <ShowMore text={text}><p className="whitespace-pre-wrap break-words text-[13px] text-text [overflow-wrap:anywhere]">{text}</p></ShowMore>
}

function ItemBody({ runId, agent, item, context }: Readonly<{ runId: string; agent: string; item: ThreadItem; context: Context }>) {
  const { t } = useTranslation('agents')
  const { text, cut } = boundedText(item)
  switch (lookOf(item)) {
    case 'said':
      return <div data-look="said"><ShowMore text={text}><TranscriptMarkdown text={text} /></ShowMore><CutNote cut={cut} /></div>
    case 'thought':
      return (
        <Folded icon={Brain} summary={t('runWorkspace.thread.thought')} preview={firstLine(text)}>
          <ShowMore text={text}><TranscriptMarkdown text={text} quiet /></ShowMore><CutNote cut={cut} />
        </Folded>
      )
    case 'tool':
      return <ToolLine runId={runId} agent={agent} item={item} ended={context.ended} />
    case 'folded':
      return (
        <Folded icon={Bot} summary={t('runWorkspace.thread.toModel', { id: item.from.id })}>
          <ShowMore text={text}>
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] text-muted [overflow-wrap:anywhere]">{text}</pre>
          </ShowMore>
          <CutNote cut={cut} />
        </Folded>
      )
    case 'steer':
      return (
        <div className="rounded-md border-l-4 border-accent bg-accent-subtle px-3 py-1.5 text-[13px]">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-accent-text">
            <Compass size={12} aria-hidden="true" /> {t('runWorkspace.thread.steering')}
          </p>
          <ShowMore text={text}><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p></ShowMore>
        </div>
      )
    case 'message':
      return <MessageBody item={item} text={text} context={context} />
    case 'event':
      return <EventLine item={item} />
  }
}

/**
 * One item; `header` starts a message group (who, and when); `reply`: the thread of the agent's own question this
 * item is, which an admin may answer on (QuestionReply.tsx); `said`: every item it stands for (7.51.04: the latest
 * of a run of the supervisor's same line stands for the run; else itself), `orchestrator` the run's.
 */
export function ThreadItemView({ runId, agent, item, header, reply, said = [item], orchestrator = null, ended = false }: Readonly<{
  runId: string; agent: string; item: ThreadItem; header: boolean; reply?: string
  /** (7.54.00) The thread has ended: a call with no result will get none. */
  ended?: boolean
  said?: readonly ThreadItem[]; orchestrator?: string | null
}>) {
  return (
    <li className="px-3 py-0.5" data-ref={item.ref}>
      {header && <SenderLine item={item} />}
      <ItemBody runId={runId} agent={agent} item={item} context={{ said, orchestrator, ended }} />
      {reply !== undefined && <QuestionReply runId={runId} agent={agent} threadId={reply} />}
    </li>
  )
}
