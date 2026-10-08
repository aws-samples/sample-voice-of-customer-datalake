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
import { useEffect, useRef, useState } from 'react'
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
import { ownEntry } from '../ownEntry'
import {
  NavigationChips, PersonaAnswers, ReasoningBlock, SourcesBlock, ToolSteps,
} from './messageParts'
import { parsePersonaResponses } from './messageHelpers'
import { NoImage, SafeLink } from './SafeLink'
import type { AssistantMessage, Message, UserMessage } from '@ag-ui/core'
import type { PageContext } from '../contract'
import type { ThreadState } from '../thread/types'

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
  const { t } = useTranslation('assistant')
  const [state, setState] = useState<SaveState>('idle')
  const save = async (content: string) => {
    if (projectId === undefined) return
    setState('saving')
    try {
      await projectsApi.createDocument(projectId, {
        title: t('message.savedDocumentTitle', { date: new Date().toLocaleDateString() }),
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

function AssistantBubble({ message, thread, page, isStreaming }: Readonly<{
  message: AssistantMessage
  thread: ThreadState
  page: PageContext
  isStreaming: boolean
}>) {
  const text = message.content ?? ''
  const reasoning = ownEntry(thread.reasoningByMessage, message.id) ?? ''
  const sources = ownEntry(thread.sources, message.id)
  const navigation = ownEntry(thread.navigation, message.id)
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%] min-w-0">
        {reasoning !== '' && <ReasoningBlock text={reasoning} />}
        <ToolSteps calls={message.toolCalls ?? []} statuses={thread.toolCallStatus} />
        <PersonaAnswers responses={personaResponsesFor(message, thread)} />
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

function MessageRow({ message, thread, page, isStreaming }: Readonly<{
  message: Message
  thread: ThreadState
  page: PageContext
  isStreaming: boolean
}>) {
  if (message.role === 'user') return <UserBubble message={message} />
  if (message.role === 'assistant') return <AssistantBubble message={message} thread={thread} page={page} isStreaming={isStreaming} />
  return null
}

export default function MessageList({ thread, page }: Readonly<{ thread: ThreadState; page: PageContext }>) {
  const { t } = useTranslation('assistant')
  const endRef = useRef<HTMLDivElement>(null)
  const streaming = thread.status === 'streaming'
  const generating = thread.status === 'generating'
  const last = thread.messages.at(-1)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [thread.messages.length, last])

  return (
    <div className="space-y-3" aria-live="polite" aria-busy={streaming || generating} aria-label={t('panel.messages')} role="log">
      {thread.messages.map((m) => (
        <MessageRow key={m.id} message={m} thread={thread} page={page} isStreaming={streaming && m.id === thread.lastAssistantId} />
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
