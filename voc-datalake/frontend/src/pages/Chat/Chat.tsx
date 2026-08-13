/**
 * @fileoverview AI Chat page with real-time SSE streaming.
 *
 * Features:
 * - Token-by-token streaming via API Gateway SSE
 * - Extended thinking indicator (collapsible)
 * - Tool use indicators (search_feedback)
 * - Conversation history with sidebar
 * - Filter context for scoped queries
 * - Suggested questions for quick start
 * - Export conversations to PDF/Markdown
 */

import {
  Send, Bot, Loader2, Sparkles, PanelLeftClose, PanelLeft, Brain, X,
} from 'lucide-react'
import {
  useState, useRef, useEffect, useId, type SyntheticEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TFunction } from 'i18next'
import { getDaysFromRange } from '../../api/baseUrl'
import type { FeedbackItem, WebSource } from '../../api/client'
import { MAX_CHAT_MESSAGE_LENGTH } from '../../api/streamLimits'
import { buildChatContext } from './chatContext'
import { composerState } from './composerState'
import ChatExportMenu from '../../components/ChatExportMenu'
import ChatFilters from '../../components/ChatFilters'
import ChatMessage from '../../components/ChatMessage'
import ChatSidebar from '../../components/ChatSidebar'
import { useStreamChat } from '../../hooks/useStreamChat'
import {
  useChatStore, type ChatFilters as ChatFiltersType, type ChatMessage as StoredChatMessage,
  type Conversation,
} from '../../store/chatStore'
import { useConfigStore } from '../../store/configStore'
import { buildHistory } from '../../constants/chat'

const suggestedQuestionKeys = [
  'suggestedQuestions.topComplaints',
  'suggestedQuestions.urgentIssues',
  'suggestedQuestions.sentimentTrend',
  'suggestedQuestions.negativeSource',
  'suggestedQuestions.mainProblems',
  'suggestedQuestions.pricing',
] as const

function EmptyState({ onSelectQuestion }: Readonly<{ onSelectQuestion: (q: string) => void }>) {
  const { t } = useTranslation('chat')
  return (
    <div className="h-full flex flex-col items-center justify-center px-2">
      <Sparkles size={40} className="text-gray-300 mb-4 sm:w-12 sm:h-12" />
      <p className="text-gray-500 mb-4 sm:mb-6 text-sm sm:text-base text-center">{t('emptyState')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
        {suggestedQuestionKeys.map((key) => {
          const question = t(key)
          return (
            <button
              key={key}
              onClick={() => onSelectQuestion(question)}
              className="text-left p-2.5 sm:p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors text-xs sm:text-sm text-gray-700"
            >
              {question}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ToolIndicator({ toolName }: Readonly<{ toolName: string }>) {
  return (
    <div className="flex items-center gap-2 text-xs text-purple-600 bg-purple-50 rounded-lg px-3 py-1.5 mb-2">
      <Loader2 size={12} className="animate-spin" />
      <span>Searching: {toolName.replaceAll('_', ' ')}</span>
    </div>
  )
}

function ThinkingIndicator({ thinking }: Readonly<{ thinking: string }>) {
  const [expanded, setExpanded] = useState(false)
  if (thinking === '') return null
  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
      >
        <Brain size={14} className="animate-pulse" />
        <span>Reasoning...</span>
      </button>
      {expanded ? <div className="text-xs text-gray-400 bg-gray-50 rounded p-2 mt-1 max-h-32 overflow-y-auto">
        {thinking}
      </div> : null}
    </div>
  )
}

function StreamingMessage({
  content,
  thinking,
  activeTools,
}: Readonly<{
  content: string;
  thinking: string;
  activeTools: string[]
}>) {
  return (
    <div className="flex gap-2 sm:gap-3">
      <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-blue-100 rounded-full flex items-center justify-center">
        <Bot size={16} className="text-blue-600 sm:w-[18px] sm:h-[18px]" />
      </div>
      <div className="max-w-[85%] sm:max-w-[75%] min-w-0">
        <div className="bg-white border border-gray-200 rounded-lg p-3 sm:p-4">
          <ThinkingIndicator thinking={thinking} />
          {activeTools.map((tool) => (
            <ToolIndicator key={tool} toolName={tool} />
          ))}
          {content === '' ? (
            thinking === '' && activeTools.length === 0 && (
              <Loader2 className="animate-spin text-gray-400" size={18} />
            )
          ) : (
            <div className="prose prose-sm max-w-none text-sm sm:text-base">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-0.5 rounded-sm" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ChatHeader({
  showSidebar,
  onToggleSidebar,
  conversation,
}: Readonly<{
  showSidebar: boolean
  onToggleSidebar: () => void
  conversation: Conversation | null
}>) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-gray-100 bg-white">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded flex-shrink-0"
          title={showSidebar ? t('hideHistory') : t('showHistory')}
        >
          {showSidebar ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
        </button>
        <div className="p-1.5 sm:p-2 bg-blue-100 rounded-lg flex-shrink-0">
          <Bot size={18} className="text-blue-600 sm:w-5 sm:h-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-semibold truncate">{t('assistantName')}</h2>
          <p className="text-xs text-gray-500 hidden sm:block">{t('assistantDescription')}</p>
        </div>
      </div>
      <ChatExportMenu conversation={conversation ?? null} />
    </div>
  )
}

function SidebarSection({
  showSidebar, onClose,
}: Readonly<{
  showSidebar: boolean;
  onClose: () => void
}>) {
  if (!showSidebar) return null
  return (
    <>
      <button type="button" className="fixed inset-0 bg-black/50 z-40 md:hidden border-none cursor-default" onClick={onClose} aria-label="Close sidebar" />
      <div className="fixed inset-y-0 left-0 z-50 md:hidden">
        <ChatSidebar onClose={onClose} />
      </div>
      <div className="hidden md:block">
        <ChatSidebar />
      </div>
    </>
  )
}

/** The over-length reason, kept in its own component so Chat carries no branch. */
function MessageTooLongNotice({
  id, show, max,
}: Readonly<{ id: string, show: boolean, max: number }>) {
  const { t } = useTranslation('chat')
  if (!show) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-700">
      {t('messageTooLong', { max })}
    </p>
  )
}

/** The streaming values the finish-effect needs, as held in `latestRef`. */
interface FinishedStreamValues {
  streamingText: string
  thinkingText: string
  streamError: string | null
  sources: FeedbackItem[]
  webSources: WebSource[]
  filters: ChatFiltersType
  addMessage: (conversationId: string, message: Omit<StoredChatMessage, 'id' | 'timestamp'>) => void
  t: TFunction
}

/**
 * Persist the finished stream to the conversation it was *sent from*.
 *
 * Extracted from the finish-effect so the effect body stays a plain
 * edge-detect-then-act, with the message-shaping branches out of the way.
 *
 * The early return below drops the error alongside the partial text, which
 * looks like it could swallow a server-reported reason on the cancel path. It
 * cannot, today, and the reason is an invariant of the *server* rather than of
 * this function — so it is written down here rather than left to be rediscovered:
 *
 * - The only emitter of `type: 'error'` is `sendErrorAndClose`
 *   (in `lambda/stream/src/lib/streaming.ts`), which writes the error, then
 *   `done`, then `stream.end()` in one batch. The client therefore parses all
 *   three from the same read and leaves the `for await` in the same tick, so the
 *   `isStreaming` falling edge fires while the origin ref is still set and the
 *   error IS saved by the `else if (error…)` branch. No human click can land in
 *   between.
 * - The other way `error` gets set is `useStreamChat`'s catch, which returns
 *   early on `signal.aborted` — so a post-cancel failure sets nothing at all.
 *
 * Consequence, and the thing to check before trusting this again: if the server
 * ever gains a mid-stream *non-fatal* `error` emitter — one that reports a
 * reason and leaves the stream open, the way `persona_error` already does for
 * `completedTurns` — this discard becomes reachable and the cancel path has to
 * be revisited. Nothing here changes that behaviour; it only states the
 * precondition it relies on.
 *
 * @param convId The origin conversation, or null when there is nothing to save
 *   — a cancelled stream (`handleCancel` nulls the ref) or a stream that never
 *   recorded an origin.
 */
function saveFinishedStream(convId: string | null, values: FinishedStreamValues): void {
  if (convId == null || convId === '') return
  const {
    streamingText: text, thinkingText: thinking, streamError: error,
    sources: src, webSources: webSrc, filters: f, addMessage: add, t: translate,
  } = values

  if (text !== '') {
    add(convId, {
      role: 'assistant',
      content: text,
      sources: src.length > 0 ? src : undefined,
      webSources: webSrc.length > 0 ? webSrc : undefined,
      thinking: thinking === '' ? undefined : thinking,
      filters: f,
    })
  } else if (error != null && error !== '') {
    add(convId, {
      role: 'assistant',
      content: translate('errorPrefix', { message: error }),
    })
  }
}

export default function Chat() {
  const {
    t, i18n,
  } = useTranslation('chat')
  const {
    config, timeRange, customDays,
  } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDays)
  const [input, setInput] = useState('')
  const [showSidebar, setShowSidebar] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageTooLongId = useId()

  const {
    activeConversationId,
    createConversation,
    addMessage,
    getActiveConversation,
    updateConversationFilters,
    draftFilters,
    setDraftFilters,
  } = useChatStore()

  const activeConversation = getActiveConversation()
  // Treat null/undefined and '' uniformly everywhere: an empty-string id
  // must not buffer a draft that ?? would then never consume.
  const hasActiveConversation = activeConversationId != null && activeConversationId !== ''
  // Filters live on the conversation; before one exists they buffer in the
  // store's draft (issue #161: filter changes — including the web-search
  // toggle — used to silently no-op on a fresh page and snap back). The
  // next conversation to be created consumes the draft.
  const filters: ChatFiltersType = activeConversation?.filters ?? draftFilters

  const {
    isStreaming,
    streamingText,
    thinkingText,
    activeTools,
    sources,
    webSources,
    error: streamError,
    sendMessage: sendStreamMessage,
    cancel,
  } = useStreamChat()

  // Must sit below useStreamChat: it reads isStreaming, and referencing that
  // binding earlier is a TDZ error at runtime that neither tsc nor eslint flags.
  // Mirrors the stream Lambda's own cap so an over-long paste is refused here,
  // with a translated reason, instead of coming back as "Stream error: 400".
  const {
    isTooLong, canSubmit,
  } = composerState(input, isStreaming)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [activeConversation?.messages, streamingText, thinkingText])

  // Keep latest streaming values in a ref so the finish-effect never needs
  // them as dependencies.  activeConversationId is intentionally NOT stored
  // here: we capture it at send time (see originConversationIdRef below) so
  // that switching conversations mid-stream does not redirect the reply.
  const latestRef = useRef<FinishedStreamValues>({
    streamingText,
    thinkingText,
    streamError,
    sources,
    webSources,
    filters,
    addMessage,
    t,
  })
  useEffect(() => {
    latestRef.current = {
      streamingText,
      thinkingText,
      streamError,
      sources,
      webSources,
      filters,
      addMessage,
      t,
    }
  })

  /**
   * The conversation that *originated* the current stream.  Because this never
   * tracks the active conversation it is immune to the mid-stream switch bug:
   * whatever the user does after pressing Send, the reply lands in the
   * conversation it was sent from.
   *
   * Ownership: two writers, one reader.  `handleSubmit` sets it at send time;
   * `handleCancel` nulls it to suppress the save.  The finish-effect reads it
   * and then clears it unconditionally on every `isStreaming` falling edge —
   * including the edges where it declines to save — so a stale id can never be
   * mistaken for a live one.  That matters for a future send path that forgets
   * to write it (a retry or regenerate button): the reply is then *discarded*
   * rather than silently misfiled into the previous send's conversation.
   */
  const originConversationIdRef = useRef<string | null>(null)

  // When streaming finishes, save the assistant message
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const streamJustFinished = prevStreamingRef.current && !isStreaming
    prevStreamingRef.current = isStreaming
    if (!streamJustFinished) return

    saveFinishedStream(originConversationIdRef.current, latestRef.current)
    // Cleared on every falling edge, not only the ones that saved, so the ref is
    // always null-or-current at entry.  See its declaration for why.
    originConversationIdRef.current = null
  }, [isStreaming])

  const handleFiltersChange = (newFilters: ChatFiltersType) => {
    if (hasActiveConversation) {
      updateConversationFilters(activeConversationId, newFilters)
    } else {
      setDraftFilters(newFilters)
    }
  }

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault()
    // Checked here as well as on the button: Enter submits the form without
    // going through the disabled button at all.
    if (!canSubmit) return

    // Build history from existing messages before adding the new one.
    // buildHistory caps the length to the server's validation limit and
    // repairs the shape (leading assistant turn, trailing unanswered user
    // turn, same-role runs) so Bedrock never rejects the request.
    const conversation = getActiveConversation()
    const history = buildHistory(
      (conversation?.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    )

    // The first message materializes the conversation, which consumes any
    // draft filters the user set beforehand.
    const conversationId = hasActiveConversation ? activeConversationId : createConversation()
    addMessage(conversationId, {
      role: 'user',
      content: input,
      filters,
    })

    // Capture the origin conversation id NOW, before any potential
    // conversation switch.  The finish-effect reads this ref, not the
    // (mutable) active conversation id, so the reply always lands here.
    originConversationIdRef.current = conversationId

    const context = buildChatContext(days, filters)

    void sendStreamMessage(input, {
      context,
      days,
      responseLanguage: i18n.language,
      useWebSearch: filters.useWebSearch,
      history,
    })
    setInput('')
  }

  /**
   * Cancel the in-flight stream and suppress the finish-effect save.
   * Clearing `originConversationIdRef` before calling `cancel()` ensures that
   * when the finish-effect fires (the `finally` block in useStreamChat always
   * sets `isStreaming: false`) it finds a null origin and skips saving any
   * accumulated partial text to the conversation.
   */
  const handleCancel = () => {
    originConversationIdRef.current = null
    cancel()
  }

  const handleSuggestedQuestion = (question: string) => {
    setInput(question)
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Bot size={48} className="mx-auto text-gray-400 mb-4" />
          <p className="text-gray-500">{t('configureEndpoint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-11rem)] sm:h-[calc(100vh-11rem)] bg-white rounded-xl border border-gray-200 overflow-hidden w-full max-w-full">
      <SidebarSection showSidebar={showSidebar} onClose={() => setShowSidebar(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ChatHeader
          showSidebar={showSidebar}
          onToggleSidebar={() => setShowSidebar(!showSidebar)}
          conversation={activeConversation ?? null}
        />

        <div className="flex-1 overflow-auto overflow-x-hidden bg-gray-50/50 p-3 sm:p-4 space-y-3 sm:space-y-4">
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <EmptyState onSelectQuestion={handleSuggestedQuestion} />
          ) : (
            <>
              {activeConversation.messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              {isStreaming ? <StreamingMessage
                content={streamingText}
                thinking={thinkingText}
                activeTools={activeTools}
              /> : null}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="p-3 sm:p-4 border-t border-gray-100">
          <ChatFilters filters={filters} onChange={handleFiltersChange} />

          <form onSubmit={handleSubmit} className="flex gap-2">
            <div className="flex-1">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('inputPlaceholder')}
                className="input w-full text-sm sm:text-base"
                disabled={isStreaming}
                aria-invalid={isTooLong}
                aria-describedby={isTooLong ? messageTooLongId : undefined}
              />
              <MessageTooLongNotice
                id={messageTooLongId}
                show={isTooLong}
                max={MAX_CHAT_MESSAGE_LENGTH}
              />
            </div>
            {isStreaming ? (
              <button
                type="button"
                onClick={handleCancel}
                className="btn btn-secondary flex items-center gap-1 sm:gap-2 px-3 sm:px-4"
              >
                <X size={16} />
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                className="btn btn-primary flex items-center gap-1 sm:gap-2 px-3 sm:px-4"
              >
                <Send size={16} className="sm:w-[18px] sm:h-[18px]" />
                <span className="hidden sm:inline">{t('send', { ns: 'common' })}</span>
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}
