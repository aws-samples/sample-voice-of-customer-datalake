import { useState, useRef, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Send, Bot, Loader2, Sparkles, PanelLeftClose, PanelLeft } from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { useChatStore, type ChatFilters as ChatFiltersType } from '../store/chatStore'
import ChatSidebar from '../components/ChatSidebar'
import ChatMessage from '../components/ChatMessage'
import ChatFilters from '../components/ChatFilters'
import ChatExportMenu from '../components/ChatExportMenu'

const suggestedQuestions = [
  "What are the top customer complaints this week?",
  "Show me urgent issues that need attention",
  "What's the sentiment trend for delivery issues?",
  "Which source has the most negative feedback?",
  "Summarize the main problems customers are facing",
  "What are customers saying about our pricing?",
]

export default function Chat() {
  const { config, timeRange } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [input, setInput] = useState('')
  const [showSidebar, setShowSidebar] = useState(true)
  const [filters, setFilters] = useState<ChatFiltersType>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)
  
  const {
    activeConversationId,
    createConversation,
    addMessage,
    getActiveConversation,
    updateConversationFilters,
  } = useChatStore()

  const activeConversation = getActiveConversation()



  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [activeConversation?.messages])

  useEffect(() => {
    if (activeConversation) {
      setFilters(activeConversation.filters || {})
    }
  }, [activeConversationId])

  const handleFiltersChange = (newFilters: ChatFiltersType) => {
    setFilters(newFilters)
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || chatMutation.isPending) return

    let conversationId = activeConversationId
    if (!conversationId) {
      conversationId = createConversation()
    }

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
    <div className="flex h-[calc(100vh-11rem)] bg-white rounded-xl border border-gray-200 overflow-hidden w-full max-w-full">
      {showSidebar && <ChatSidebar />}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-white">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
              title={showSidebar ? 'Hide history' : 'Show history'}
            >
              {showSidebar ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </button>
            <div className="p-2 bg-blue-100 rounded-lg">
              <Bot size={20} className="text-blue-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold">VoC AI Assistant</h2>
              <p className="text-xs text-gray-500">Ask questions about your customer feedback data</p>
            </div>
          </div>
          <ChatExportMenu conversation={activeConversation} />
        </div>

        <div className="flex-1 overflow-auto overflow-x-hidden bg-gray-50/50 p-4 space-y-4">
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center">
              <Sparkles size={48} className="text-gray-300 mb-4" />
              <p className="text-gray-500 mb-6">Start a conversation about your customer feedback</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-2xl">
                {suggestedQuestions.map((question, index) => (
                  <button
                    key={index}
                    onClick={() => handleSuggestedQuestion(question)}
                    className="text-left p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors text-sm text-gray-700"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {activeConversation.messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              
              {chatMutation.isPending && (
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                    <Bot size={18} className="text-blue-600" />
                  </div>
                  <div className="bg-white border border-gray-200 rounded-lg p-4">
                    <Loader2 className="animate-spin text-gray-400" size={20} />
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="p-4 border-t border-gray-100">
          <ChatFilters filters={filters} onChange={handleFiltersChange} />
          
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your customer feedback..."
              className="input flex-1"
              disabled={chatMutation.isPending}
            />
            <button
              type="submit"
              disabled={!input.trim() || chatMutation.isPending}
              className="btn btn-primary flex items-center gap-2"
            >
              <Send size={18} />
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
