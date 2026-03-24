import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FeedbackItem } from '../api/client'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: FeedbackItem[]
  thinking?: string
  timestamp: Date
  filters?: ChatFilters
}

export interface ChatFilters {
  source?: string
  category?: string
  sentiment?: string
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  filters: ChatFilters
  createdAt: Date
  updatedAt: Date
}

interface ChatStore {
  conversations: Conversation[]
  activeConversationId: string | null
  
  // Actions
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  updateConversationTitle: (id: string, title: string) => void
  updateConversationFilters: (id: string, filters: ChatFilters) => void
  getActiveConversation: () => Conversation | null
  clearAllConversations: () => void
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,

      createConversation: () => {
        const id = `conv_${Date.now()}`
        const newConversation: Conversation = {
          id,
          title: 'New Conversation',
          messages: [],
          filters: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) => {
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
        }))
      },

      setActiveConversation: (id) => {
        set({ activeConversationId: id })
      },

      addMessage: (conversationId, message) => {
        const newMessage: ChatMessage = {
          ...message,
          id: `msg_${Date.now()}`,
          timestamp: new Date(),
        }
        
        set((state) => ({
          conversations: state.conversations.map((conv) => {
            if (conv.id !== conversationId) return conv
            
            const updatedMessages = [...conv.messages, newMessage]
            // Auto-generate title from first user message
            const shouldGenerateTitle = conv.title === 'New Conversation' && message.role === 'user'
            const truncatedContent = message.content.slice(0, 50)
            const suffix = message.content.length > 50 ? '...' : ''
            const title = shouldGenerateTitle ? truncatedContent + suffix : conv.title
            
            return {
              ...conv,
              title,
              messages: updatedMessages,
              updatedAt: new Date(),
            }
          }),
        }))
      },

      updateConversationTitle: (id, title) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === id ? { ...conv, title, updatedAt: new Date() } : conv
          ),
        }))
      },

      updateConversationFilters: (id, filters) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === id ? { ...conv, filters, updatedAt: new Date() } : conv
          ),
        }))
      },

      getActiveConversation: () => {
        const state = get()
        return state.conversations.find((c) => c.id === state.activeConversationId) || null
      },

      clearAllConversations: () => {
        set({ conversations: [], activeConversationId: null })
      },
    }),
    {
      name: 'voc-chat-history',
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
      }),
    }
  )
)
