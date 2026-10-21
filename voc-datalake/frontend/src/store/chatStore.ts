import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FeedbackItem, WebSource } from '../api/client'
import {
  EMPTY_FEEDBACK_FILTERS,
  normalizeFeedbackFilters,
  type FeedbackFilterState,
} from '../api/feedbackFilters'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: FeedbackItem[]
  webSources?: WebSource[]
  thinking?: string
  timestamp: Date
  filters?: FeedbackFilterState
}

/**
 * The per-conversation filter selection: the shared feedback dimensions (same
 * model the Dashboard/Categories/Problem Analysis pages use), plus the one
 * thing that is NOT a feedback dimension — the opt-in public web search
 * capability, offered only when the deployment has the AgentCore gateway.
 */
export interface ConversationFilters {
  readonly feedback: FeedbackFilterState
  readonly useWebSearch?: boolean
}

export const EMPTY_CONVERSATION_FILTERS: ConversationFilters = Object.freeze({
  feedback: EMPTY_FEEDBACK_FILTERS,
})

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  filters: ConversationFilters
  createdAt: Date
  updatedAt: Date
}

interface ChatStore {
  conversations: Conversation[]
  activeConversationId: string | null
  /** Filters chosen while NO conversation is active (issue #161: they used
   * to silently no-op). Ephemeral by design (not persisted): the next
   * conversation to be created consumes them, however it is created (first
   * message on the Chat page or the sidebar's New Chat). */
  draftFilters: ConversationFilters

  // Actions
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  updateConversationTitle: (id: string, title: string) => void
  updateConversationFilters: (id: string, filters: ConversationFilters) => void
  setDraftFilters: (filters: ConversationFilters) => void
  getActiveConversation: () => Conversation | null
  clearAllConversations: () => void
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      draftFilters: EMPTY_CONVERSATION_FILTERS,

      createConversation: () => {
        // crypto.randomUUID over Date.now(): two calls in the same
        // millisecond produced identical IDs (issue #160) — a real store
        // corruption risk and an observed test flake under full-suite load.
        // randomUUID requires a secure context (https/localhost); dev over a
        // plain-http LAN IP is not a supported workflow.
        const id = `conv_${crypto.randomUUID()}`
        const draft = get().draftFilters
        const newConversation: Conversation = {
          id,
          title: 'New Conversation',
          messages: [],
          // The new conversation consumes any draft filters chosen before it
          // existed instead of silently resetting them — regardless of
          // whether it was created by the first message or the sidebar's
          // New Chat. Copied so no live reference is shared with the draft.
          filters: { feedback: draft.feedback, useWebSearch: draft.useWebSearch },
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: id,
          draftFilters: EMPTY_CONVERSATION_FILTERS,
        }))
        return id
      },

      setDraftFilters: (filters) => {
        set({ draftFilters: filters })
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
          // Collision-proof (see createConversation).
          id: `msg_${crypto.randomUUID()}`,
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
      // Persisted conversations predate the shared filter model (issue #161
      // stored the old `{source,category,sentiment,useWebSearch}` shape). Run
      // every conversation's filters through the lenient normalizer so an old
      // record degrades to EMPTY_FEEDBACK_FILTERS instead of crashing a render.
      merge: (persisted, current) => ({
        ...current,
        ...migratePersisted(persisted),
      }),
    }
  )
)

/** The persisted conversation shape, before migration. Untrusted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The old per-conversation filter shape, as still found in localStorage:
 * `{ source?, category?, sentiment?, useWebSearch? }`. Each dimension maps to a
 * one-value list in the shared model; anything unrecognised degrades to empty.
 */
function migrateFilters(raw: unknown): ConversationFilters {
  if (!isRecord(raw)) return EMPTY_CONVERSATION_FILTERS
  // A record already carrying the new nested `feedback` shape (a conversation
  // persisted after this change): normalize it in place.
  if ('feedback' in raw) {
    return {
      feedback: normalizeFeedbackFilters(raw.feedback),
      useWebSearch: raw.useWebSearch === true ? true : undefined,
    }
  }
  const single = (value: unknown): string[] => (typeof value === 'string' && value !== '' ? [value] : [])
  const feedback = normalizeFeedbackFilters({
    sources: single(raw.source),
    categories: single(raw.category),
    sentiments: single(raw.sentiment),
  })
  return { feedback, useWebSearch: raw.useWebSearch === true ? true : undefined }
}

/** Persisted dates come back as ISO strings; rebuild Date without asserting. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') return new Date(value)
  return new Date()
}

/** A stored message is replayed as-is for display; only its shape is checked. */
function migrateMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((m) => ({
    id: typeof m.id === 'string' ? m.id : `msg_${crypto.randomUUID()}`,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : '',
    sources: Array.isArray(m.sources) ? m.sources : undefined,
    webSources: Array.isArray(m.webSources) ? m.webSources : undefined,
    thinking: typeof m.thinking === 'string' ? m.thinking : undefined,
    timestamp: toDate(m.timestamp),
    filters: 'filters' in m ? migrateFilters(m.filters).feedback : undefined,
  }))
}

function migrateConversation(raw: unknown): Conversation | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : 'New Conversation',
    messages: migrateMessages(raw.messages),
    filters: migrateFilters(raw.filters),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
  }
}

function migratePersisted(persisted: unknown): {
  conversations: Conversation[]
  activeConversationId: string | null
} {
  if (!isRecord(persisted)) return { conversations: [], activeConversationId: null }
  const rawConversations = Array.isArray(persisted.conversations) ? persisted.conversations : []
  const conversations = rawConversations
    .map(migrateConversation)
    .filter((c): c is Conversation => c !== null)
  const activeId = persisted.activeConversationId
  return {
    conversations,
    activeConversationId: typeof activeId === 'string' ? activeId : null,
  }
}
