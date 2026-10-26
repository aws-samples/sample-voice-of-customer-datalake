/**
 * @fileoverview The thread's message list: user bubbles, assistant answers
 * (markdown, reasoning, tool steps, persona answers, sources, navigation) and
 * per-answer actions (copy; on a project page, save as document).
 *
 * `tool` messages are not rendered as bubbles — their effect shows on the tool
 * step chip of the call they answer (and `consult_personas` as persona cards).
 *
 * @module assistant/components/MessageList
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, FilePlus2, Loader2, Paperclip } from 'lucide-react'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { GhostThinking } from '../../components/KiroGhost/GhostPoses'
import { contentToText } from '../thread/reducer'
import { attachmentName } from '../thread/wire'
import { formatDate } from '../../utils/dateUtils'
import { ownEntry } from '../ownEntry'
import {
  NavigationChips, PersonaAnswers, ReasoningBlock, SourcesBlock, ToolSteps,
} from './messageParts'
import { navigationAtTurnEnd, parsePersonaResponses } from './messageHelpers'
import PlanProgress from '../planProgress/PlanProgress'
import { approvedPlanIds } from '../planProgress/planIds'
import { useAssistantUiStore } from '../store/assistantStore'
import { NoImage, SafeLink } from './SafeLink'
import type { AssistantMessage, Message, ToolCall, UserMessage } from '@ag-ui/core'
import type { PageContext } from '../contract'
import type { NavigationSuggestion, ThreadState } from '../thread/types'

const CONSULT_PERSONAS = 'consult_personas'
/** Model markdown: only safe links, never images (see SafeLink). */
const MARKDOWN_COMPONENTS = { a: SafeLink, img: NoImage }

function UserBubble({ message }: Readonly<{ message: UserMessage }>) {
  const text = contentToText(message.content)
  const files = typeof message.content === 'string' ? [] : message.content.filter((p) => p.type !== 'text')
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent px-3 py-2 text-sm text-accent-fg animate-rise">
        {text !== '' && <p className="whitespace-pre-wrap break-words">{text}</p>}
        {files.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[12px] text-accent-fg/80">
            {files.map((part, i) => (
              <li key={`${attachmentName(part)}-${i}`} className="flex items-center gap-1">
                <Paperclip size={12} aria-hidden />
                {attachmentName(part)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function useSaveAsDocument(projectId: string | undefined) {
  const queryClient = useQueryClient()
  const { t, i18n } = useTranslation('assistant')
  const [state, setState] = useState<SaveState>('idle')
  const save = async (content: string) => {
    if (projectId === undefined) return
    setState('saving')
    try {
      await projectsApi.createDocument(projectId, {
        title: t('message.savedDocumentTitle', { date: formatDate(new Date(), i18n.language) }),
        content,
        document_type: 'custom',
      })
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      setState('saved')
    } catch {
      setState('error')
    }
  }
  return { state, save }
}

function AnswerActions({ text, page }: Readonly<{ text: string; page: PageContext }>) {
  const { t } = useTranslation('assistant')
  const { copy, copiedKey } = useCopyToClipboard()
  const projectId = page.kind === 'project' ? page.projectId : undefined
  const { state, save } = useSaveAsDocument(projectId)
  if (text.trim() === '') return null
  return (
    <div className="mt-1 flex items-center gap-1">
      <button type="button" onClick={() => copy(text)} className="btn btn-ghost btn-sm">
        {copiedKey === null ? <Copy size={12} aria-hidden /> : <Check size={12} aria-hidden />}
        {copiedKey === null ? t('message.copy') : t('message.copied')}
      </button>
      {projectId !== undefined && (
        <button
          type="button"
          disabled={state === 'saving' || state === 'saved'}
          onClick={() => {
            void save(text)
          }}
          className="btn btn-ghost btn-sm"
        >
          {state === 'saving' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <FilePlus2 size={12} aria-hidden />}
          {t(`message.saveAsDocument.${state}`)}
        </button>
      )}
    </div>
  )
}

function personaResponsesFor(message: AssistantMessage, thread: ThreadState) {
  return (message.toolCalls ?? [])
    .filter((c) => c.function.name === CONSULT_PERSONAS)
    .flatMap((c) => {
      const result = ownEntry(thread.toolResults, c.id)
      return result === undefined ? [] : parsePersonaResponses(result)
    })
}

/** Progress of each plan this message started (the panel is open while this renders). */
function PlanBlocks({ planIds }: Readonly<{ planIds: readonly string[] }>) {
  const setOpen = useAssistantUiStore((s) => s.setOpen)
  if (planIds.length === 0) return null
  return (
    <div className="my-2 space-y-2">
      {planIds.map((id) => <PlanProgress key={id} planId={id} onOpen={() => setOpen(true)} />)}
    </div>
  )
}

/** Every text is empty, every list is empty and every optional block is absent. */
function nothingToShow(texts: readonly string[], lists: readonly (readonly unknown[])[], blocks: readonly unknown[]): boolean {
  return texts.every((value) => value === '') && lists.every((list) => list.length === 0) && blocks.every((block) => block === undefined)
}

function AssistantBubble({ message, thread, page, isStreaming, navigation, toolCalls }: Readonly<{
  message: AssistantMessage
  /** The tool steps to show above this message (groupedToolCalls). */
  toolCalls: readonly ToolCall[]
  thread: ThreadState
  page: PageContext
  isStreaming: boolean
  /** The answer's link chips, when this is its last message (shown after the text). */
  navigation: readonly NavigationSuggestion[] | undefined
}>) {
  const text = message.content ?? ''
  const reasoning = ownEntry(thread.reasoningByMessage, message.id) ?? ''
  const sources = ownEntry(thread.sources, message.id)
  const personas = personaResponsesFor(message, thread)
  const plans = approvedPlanIds(message.toolCalls ?? [], thread)
  // A tool-only turn whose steps show on the group's first message renders nothing (no empty gap).
  if (nothingToShow([text, reasoning], [toolCalls, personas, plans], [sources, navigation])) return null
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%] min-w-0">
        {reasoning !== '' && <ReasoningBlock text={reasoning} />}
        <ToolSteps calls={toolCalls} statuses={thread.toolCallStatus} />
        <PersonaAnswers responses={personas} />
        <PlanBlocks planIds={plans} />
        {text !== '' && (
          <div className="md-content break-words rounded-xl rounded-bl-sm border border-border bg-bg-accent px-3 py-2 text-sm text-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
          </div>
        )}
        {sources !== undefined && <SourcesBlock sources={sources} />}
        {navigation !== undefined && <NavigationChips items={navigation} />}
        {!isStreaming && <AnswerActions text={text} page={page} />}
      </div>
    </div>
  )
}

/**
 * The tool calls each assistant message shows. A run of assistant messages with no text of
 * their own (the model calling tools turn after turn) shows ALL its calls once, on its first
 * message, up to and including the message that finally answers; the others show none. A user
 * message ends the run.
 */
function groupedToolCalls(messages: readonly Message[]): ReadonlyMap<string, readonly ToolCall[]> {
  const shown = new Map<string, ToolCall[]>()
  const run: { lead: string | null } = { lead: null }
  for (const message of messages) {
    if (message.role === 'user') run.lead = null
    if (message.role === 'assistant') addToRun(shown, run, message)
  }
  return shown
}

/** One assistant message into the current run: its calls join the run's lead, or it leads a new run. */
function addToRun(shown: Map<string, ToolCall[]>, run: { lead: string | null }, message: AssistantMessage): void {
  const calls = message.toolCalls ?? []
  const lead = run.lead === null ? undefined : shown.get(run.lead)
  if (lead !== undefined && calls.length > 0) {
    lead.push(...calls)
    shown.set(message.id, [])
  } else {
    shown.set(message.id, [...calls])
    if (calls.length > 0) run.lead = message.id
  }
  // A message with text of its own ends the run: the next call belongs to a new step list.
  if ((message.content ?? '') !== '') run.lead = null
}

function MessageRow({ message, thread, page, isStreaming, navigation, toolCalls }: Readonly<{
  message: Message
  thread: ThreadState
  page: PageContext
  isStreaming: boolean
  navigation: readonly NavigationSuggestion[] | undefined
  toolCalls: readonly ToolCall[]
}>) {
  if (message.role === 'user') return <UserBubble message={message} />
  if (message.role === 'assistant') {
    return <AssistantBubble message={message} thread={thread} page={page} isStreaming={isStreaming} navigation={navigation} toolCalls={toolCalls} />
  }
  return null
}

export default function MessageList({ thread, page }: Readonly<{ thread: ThreadState; page: PageContext }>) {
  const { t } = useTranslation('assistant')
  const endRef = useRef<HTMLDivElement>(null)
  const streaming = thread.status === 'streaming'
  const generating = thread.status === 'generating'
  const last = thread.messages.at(-1)
  const chips = useMemo(() => navigationAtTurnEnd(thread.messages, thread.navigation), [thread.messages, thread.navigation])
  const toolCalls = useMemo(() => groupedToolCalls(thread.messages), [thread.messages])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [thread.messages.length, last])

  return (
    <div className="space-y-3" aria-live="polite" aria-busy={streaming || generating} aria-label={t('panel.messages')} role="log">
      {thread.messages.map((m) => (
        <MessageRow
          key={m.id}
          message={m}
          thread={thread}
          page={page}
          isStreaming={streaming && m.id === thread.lastAssistantId}
          navigation={ownEntry(chips, m.id)}
          toolCalls={toolCalls.get(m.id) ?? []}
        />
      ))}
      {streaming && last?.role !== 'assistant' && (
        <p className="flex items-center gap-1.5 text-[12px] text-aim">
          <GhostThinking className="h-5 w-5" />
          {t('panel.thinking')}
        </p>
      )}
      {generating && (
        <p className="flex items-center gap-1.5 text-[12px] text-aim" role="status">
          <GhostThinking className="h-5 w-5" />
          {t('panel.stillGenerating')}
        </p>
      )}
      <div ref={endRef} />
    </div>
  )
}
