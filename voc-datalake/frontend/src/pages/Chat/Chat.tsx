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
  useState, useRef, useEffect, type SyntheticEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getDaysFromRange } from '../../api/baseUrl'
import ChatExportMenu from '../../components/ChatExportMenu'
import ChatFilters from '../../components/ChatFilters'
import ChatMessage from '../../components/ChatMessage'
import ChatSidebar from '../../components/ChatSidebar'
import { useStreamChat } from '../../hooks/useStreamChat'
import {
  useChatStore, type ChatFilters as ChatFiltersType, type Conversation,
} from '../../store/chatStore'
import { useConfigStore } from '../../store/configStore'

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

function buildChatContext(days: number, filters: ChatFiltersType): string {
  const parts = [`Time range: last ${days} days`]
  if (filters.source != null && filters.source !== '') parts.push(`Source: ${filters.source}`)
  if (filters.category != null && filters.category !== '') parts.push(`Category: ${filters.category}`)
  if (filters.sentiment != null && filters.sentiment !== '') parts.push(`Sentiment: ${filters.sentiment}`)
  return parts.join('. ')
}

export default function Chat() {
  const {
    t, i18n,
  } = useTranslation('chat')
  const {
    config, timeRange,
  } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [input, setInput] = useState('')
  const [showSidebar, setShowSidebar] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const {
    activeConversationId,
    createConversation,
    addMessage,
    getActiveConversation,
    updateConversationFilters,
  } = useChatStore()

  const activeConversation = getActiveConversation()
  const filters: ChatFiltersType = activeConversation?.filters ?? {}

  const {
    isStreaming,
    streamingText,
    thinkingText,
    activeTools,
    sources,
    error: streamError,
    sendMessage: sendStreamMessage,
    cancel,
  } = useStreamChat()

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [activeConversation?.messages, streamingText, thinkingText])

  // Keep latest values in refs so the streaming-finish effect doesn't need them as deps
  const latestRef = useRef({
    streamingText,
    thinkingText,
    streamError,
    sources,
    filters,
    activeConversationId,
    addMessage,
    t,
  })
  useEffect(() => {
    latestRef.current = {
      streamingText,
      thinkingText,
      streamError,
      sources,
      filters,
      activeConversationId,
      addMessage,
      t,
    }
  })

  // When streaming finishes, save the assistant message
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const {
      streamingText: text, thinkingText: thinking, streamError: error, sources: src, filters: f, activeConversationId: convId, addMessage: add, t: translate,
    } = latestRef.current
    if (prevStreamingRef.current && !isStreaming && convId != null && convId !== '') {
      if (text !== '') {
        add(convId, {
          role: 'assistant',
          content: text,
          sources: src.length > 0 ? src : undefined,
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
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  const handleFiltersChange = (newFilters: ChatFiltersType) => {
    if (activeConversationId != null && activeConversationId !== '') {
      updateConversationFilters(activeConversationId, newFilters)
    }
  }

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault()
    if (input.trim() === '' || isStreaming) return

    // Build history from existing messages before adding the new one
    const conversation = getActiveConversation()
    const history = (conversation?.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    const conversationId = activeConversationId ?? createConversation()
    addMessage(conversationId, {
      role: 'user',
      content: input,
      filters,
    })

    const context = buildChatContext(days, filters)

    void sendStreamMessage(input, {
      context,
      days,
      responseLanguage: i18n.language,
      history,
    })
    setInput('')
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
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('inputPlaceholder')}
              className="input flex-1 text-sm sm:text-base"
              disabled={isStreaming}
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={cancel}
                className="btn btn-secondary flex items-center gap-1 sm:gap-2 px-3 sm:px-4"
              >
                <X size={16} />
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={input.trim() === ''}
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
