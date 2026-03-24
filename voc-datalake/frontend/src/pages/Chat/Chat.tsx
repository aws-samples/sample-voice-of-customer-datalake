/**
 * @fileoverview AI Chat page for conversational data queries.
 *
 * Features:
 * - Natural language queries about feedback data
 * - Streaming responses via Lambda Function URL
 * - Conversation history with sidebar
 * - Filter context for scoped queries
 * - Suggested questions for quick start
 * - Export conversations to PDF/Markdown
 *
 * @module pages/Chat
 */

import { useState, useRef, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Send, Bot, Loader2, Sparkles, PanelLeftClose, PanelLeft } from 'lucide-react'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useChatStore, type ChatFilters as ChatFiltersType, type Conversation } from '../../store/chatStore'
import ChatSidebar from '../../components/ChatSidebar'
import ChatMessage from '../../components/ChatMessage'
import ChatFilters from '../../components/ChatFilters'
import ChatExportMenu from '../../components/ChatExportMenu'

const suggestedQuestions = [
  "What are the top customer complaints this week?",
  "Show me urgent issues that need attention",
  "What's the sentiment trend for delivery issues?",
  "Which source has the most negative feedback?",
  "Summarize the main problems customers are facing",
  "What are customers saying about our pricing?",
]

// Empty state component
function EmptyState({ onSelectQuestion }: Readonly<{ onSelectQuestion: (q: string) => void }>) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-2">
      <Sparkles size={40} className="text-gray-300 mb-4 sm:w-12 sm:h-12" />
      <p className="text-gray-500 mb-4 sm:mb-6 text-sm sm:text-base text-center">Start a conversation about your customer feedback</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
        {suggestedQuestions.map((question, index) => (
          <button
            key={index}
            onClick={() => onSelectQuestion(question)}
            className="text-left p-2.5 sm:p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors text-xs sm:text-sm text-gray-700"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  )
}

// Loading indicator for pending messages
function PendingMessage() {
  return (
    <div className="flex gap-2 sm:gap-3">
      <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-blue-100 rounded-full flex items-center justify-center">
        <Bot size={16} className="text-blue-600 sm:w-[18px] sm:h-[18px]" />
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-3 sm:p-4">
        <Loader2 className="animate-spin text-gray-400" size={18} />
      </div>
    </div>
  )
}

// Chat header component
function ChatHeader({ 
  showSidebar, 
  onToggleSidebar, 
  conversation 
}: Readonly<{ 
  showSidebar: boolean
  onToggleSidebar: () => void
  conversation: Conversation | null 
}>) {
  return (
    <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-gray-100 bg-white">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded flex-shrink-0"
          title={showSidebar ? 'Hide history' : 'Show history'}
        >
          {showSidebar ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
        </button>
        <div className="p-1.5 sm:p-2 bg-blue-100 rounded-lg flex-shrink-0">
          <Bot size={18} className="text-blue-600 sm:w-5 sm:h-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-semibold truncate">VoC AI Assistant</h2>
          <p className="text-xs text-gray-500 hidden sm:block">Ask questions about your customer feedback data</p>
        </div>
      </div>
      <ChatExportMenu conversation={conversation ?? null} />
    </div>
  )
}

// Sidebar components wrapper
function SidebarSection({ showSidebar, onClose }: Readonly<{ showSidebar: boolean; onClose: () => void }>) {
  if (!showSidebar) return null
  
  return (
    <>
      {/* Mobile sidebar overlay */}
      <div 
        className="fixed inset-0 bg-black/50 z-40 md:hidden"
        onClick={onClose}
      />
      {/* Mobile sidebar */}
      <div className="fixed inset-y-0 left-0 z-50 md:hidden">
        <ChatSidebar onClose={onClose} />
      </div>
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <ChatSidebar />
      </div>
    </>
  )
}

export default function Chat() {
  const { config, timeRange } = useConfigStore()
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
  
  // Derive filters from active conversation instead of syncing with useEffect
  const filters: ChatFiltersType = activeConversation?.filters ?? {}

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [activeConversation?.messages])

  const handleFiltersChange = (newFilters: ChatFiltersType) => {
    if (activeConversationId) {
      updateConversationFilters(activeConversationId, newFilters)
    }
  }

  const chatMutation = useMutation({
    mutationFn: async ({ message, conversationId }: { message: string; conversationId: string }) => {
      const contextParts = [`Time range: last ${days} days`]
      if (filters.source) contextParts.push(`Source: ${filters.source}`)
      if (filters.category) contextParts.push(`Category: ${filters.category}`)
      if (filters.sentiment) contextParts.push(`Sentiment: ${filters.sentiment}`)
      
      const context = contextParts.join('. ')
      // Use streaming endpoint for better performance (bypasses API Gateway 29s timeout)
      const response = await api.chatStream(message, context, days)
      return { response, conversationId }
    },
    onSuccess: ({ response, conversationId }) => {
      addMessage(conversationId, {
        role: 'assistant',
        content: response.response,
        sources: response.sources,
        filters,
      })
    },
    onError: (error, { conversationId }) => {
      addMessage(conversationId, {
        role: 'assistant',
        content: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}. Please check your API endpoint configuration.`,
      })
    },
  })

  const handleSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!input.trim() || chatMutation.isPending) return

    const conversationId = activeConversationId ?? createConversation()

    addMessage(conversationId, { role: 'user', content: input, filters })
    chatMutation.mutate({ message: input, conversationId })
    setInput('')
  }

  const handleSuggestedQuestion = (question: string) => {
    setInput(question)
  }

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Bot size={48} className="mx-auto text-gray-400 mb-4" />
          <p className="text-gray-500">Please configure your API endpoint in Settings to use the AI chat</p>
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
              {chatMutation.isPending && <PendingMessage />}
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
              placeholder="Ask about your feedback..."
              className="input flex-1 text-sm sm:text-base"
              disabled={chatMutation.isPending}
            />
            <button
              type="submit"
              disabled={!input.trim() || chatMutation.isPending}
              className="btn btn-primary flex items-center gap-1 sm:gap-2 px-3 sm:px-4"
            >
              <Send size={16} className="sm:w-[18px] sm:h-[18px]" />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
