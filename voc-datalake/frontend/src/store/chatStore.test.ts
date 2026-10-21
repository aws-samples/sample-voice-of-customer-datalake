/**
 * @fileoverview Tests for chatStore.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, EMPTY_CONVERSATION_FILTERS, type ConversationFilters } from './chatStore'
import { EMPTY_FEEDBACK_FILTERS, type FeedbackFilterState } from '../api/feedbackFilters'

/** A feedback-filter state with the given source selected. */
function withSource(source: string): FeedbackFilterState {
  return { ...EMPTY_FEEDBACK_FILTERS, sources: [source] }
}

/** A conversation-filter selection with one feedback source set. */
function convWithSource(source: string): ConversationFilters {
  return { feedback: withSource(source) }
}

describe('chatStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      draftFilters: EMPTY_CONVERSATION_FILTERS,
    })
  })

  describe('createConversation', () => {
    it('creates new conversation with default title', () => {
      const { createConversation } = useChatStore.getState()
      
      const id = createConversation()
      
      const state = useChatStore.getState()
      expect(state.conversations).toHaveLength(1)
      expect(state.conversations[0].title).toBe('New Conversation')
      expect(state.conversations[0].id).toBe(id)
    })

    it('generates unique IDs for back-to-back creations (issue #160)', () => {
      // Date.now()-based IDs collided within the same millisecond — two
      // conversations then shared an ID and store operations affected both.
      const ids = Array.from({ length: 50 }, () => useChatStore.getState().createConversation())

      expect(new Set(ids).size).toBe(50)
    })

    it('sets new conversation as active', () => {
      const { createConversation } = useChatStore.getState()
      
      const id = createConversation()
      
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBe(id)
    })

    it('adds new conversation at beginning of list', () => {
      const { createConversation } = useChatStore.getState()
      
      const firstId = createConversation()
      const secondId = createConversation()
      
      const state = useChatStore.getState()
      expect(state.conversations[0].id).toBe(secondId)
      expect(state.conversations[1].id).toBe(firstId)
    })

    it('initializes conversation with empty messages and filters', () => {
      const { createConversation, getActiveConversation } = useChatStore.getState()
      
      createConversation()
      
      const conversation = useChatStore.getState().getActiveConversation()
      expect(conversation?.messages).toEqual([])
      expect(conversation?.filters).toEqual(EMPTY_CONVERSATION_FILTERS)
    })
  })

  describe('deleteConversation', () => {
    it('removes conversation from list', () => {
      const { createConversation, deleteConversation } = useChatStore.getState()
      
      const id = createConversation()
      deleteConversation(id)
      
      const state = useChatStore.getState()
      expect(state.conversations).toHaveLength(0)
    })

    it('clears activeConversationId when deleting active conversation', () => {
      const { createConversation, deleteConversation } = useChatStore.getState()
      
      const id = createConversation()
      deleteConversation(id)
      
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBeNull()
    })

    it('preserves activeConversationId when deleting different conversation', () => {
      // Reset state completely first
      useChatStore.setState({ conversations: [], activeConversationId: null })
      
      // Create first conversation
      const firstId = useChatStore.getState().createConversation()
      // Back-to-back creation is safe: IDs are collision-proof (issue #160),
      // so no timestamp-separation sleep is needed (the old 1ms wait still
      // flaked under full-suite load).
      const secondId = useChatStore.getState().createConversation()
      
      // Verify we have two different conversations
      expect(firstId).not.toBe(secondId)
      expect(useChatStore.getState().conversations).toHaveLength(2)
      
      // Second is now active (createConversation sets it), set first as active
      useChatStore.getState().setActiveConversation(firstId)
      
      // Verify first is active before deletion
      expect(useChatStore.getState().activeConversationId).toBe(firstId)
      
      // Delete the second conversation (not the active one)
      useChatStore.getState().deleteConversation(secondId)
      
      // Active conversation should still be first
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBe(firstId)
      expect(state.conversations).toHaveLength(1)
    })
  })

  describe('setActiveConversation', () => {
    it('sets active conversation id', () => {
      const { createConversation, setActiveConversation } = useChatStore.getState()
      
      const id = createConversation()
      setActiveConversation(null)
      setActiveConversation(id)
      
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBe(id)
    })

    it('allows setting to null', () => {
      const { createConversation, setActiveConversation } = useChatStore.getState()
      
      createConversation()
      setActiveConversation(null)
      
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBeNull()
    })
  })

  describe('addMessage', () => {
    it('adds message to conversation', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      addMessage(convId, { role: 'user', content: 'Hello' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.messages).toHaveLength(1)
      expect(conv?.messages[0].content).toBe('Hello')
      expect(conv?.messages[0].role).toBe('user')
    })

    it('generates unique message IDs within the same tick (issue #160)', () => {
      const { createConversation, addMessage } = useChatStore.getState()

      const convId = createConversation()
      for (let i = 0; i < 50; i++) {
        addMessage(convId, { role: 'user', content: `m${i}` })
      }

      const conv = useChatStore.getState().conversations.find(c => c.id === convId)
      const ids = (conv?.messages ?? []).map(m => m.id)
      expect(new Set(ids).size).toBe(50)
    })

    it('auto-generates title from first user message', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      addMessage(convId, { role: 'user', content: 'What is the sentiment trend?' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.title).toBe('What is the sentiment trend?')
    })

    it('truncates long titles to 50 characters with ellipsis', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      const longMessage = 'This is a very long message that should be truncated when used as a title'
      addMessage(convId, { role: 'user', content: longMessage })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.title).toBe('This is a very long message that should be truncat...')
      expect(conv?.title.length).toBe(53) // 50 chars + '...'
    })

    it('does not update title from assistant messages', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      addMessage(convId, { role: 'assistant', content: 'Hello, how can I help?' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.title).toBe('New Conversation')
    })

    it('updates conversation updatedAt timestamp', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      const beforeAdd = useChatStore.getState().conversations[0].updatedAt
      
      // Small delay to ensure timestamp difference
      addMessage(convId, { role: 'user', content: 'Test' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeAdd.getTime())
    })

    it('preserves message sources when provided', () => {
      const { createConversation, addMessage } = useChatStore.getState()
      
      const convId = createConversation()
      const sources = [{ feedback_id: '123', text: 'Sample feedback' }] as any
      addMessage(convId, { role: 'assistant', content: 'Response', sources })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.messages[0].sources).toEqual(sources)
    })
  })

  describe('updateConversationTitle', () => {
    it('updates conversation title', () => {
      const { createConversation, updateConversationTitle } = useChatStore.getState()
      
      const convId = createConversation()
      updateConversationTitle(convId, 'Custom Title')
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.title).toBe('Custom Title')
    })
  })

  describe('draftFilters (issue #161)', () => {
    it('buffers filters set before any conversation exists', () => {
      const draft: ConversationFilters = { feedback: withSource('webscraper'), useWebSearch: true }
      useChatStore.getState().setDraftFilters(draft)

      expect(useChatStore.getState().draftFilters).toEqual(draft)
    })

    it('is consumed by the next conversation, however it is created', () => {
      // Covers both entry points: the first message on the Chat page and
      // the sidebar's New Chat both go through createConversation.
      const draft: ConversationFilters = { feedback: { ...EMPTY_FEEDBACK_FILTERS, sentiments: ['negative'] } }
      useChatStore.getState().setDraftFilters(draft)

      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters.feedback.sentiments).toEqual(['negative'])
      // Draft is cleared so the NEXT fresh conversation starts clean.
      expect(useChatStore.getState().draftFilters).toEqual(EMPTY_CONVERSATION_FILTERS)
    })

    it('carries the web-search flag onto the new conversation', () => {
      // useWebSearch is NOT a feedback dimension but is still per-conversation,
      // so the draft must preserve it across creation.
      useChatStore.getState().setDraftFilters({ feedback: EMPTY_FEEDBACK_FILTERS, useWebSearch: true })

      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters.useWebSearch).toBe(true)
    })

    it('creates conversations with empty filters when no draft is set', () => {
      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters).toEqual(EMPTY_CONVERSATION_FILTERS)
    })

    it('consumes a lingering draft even after the active conversation was deleted', () => {
      // Store-level lifecycle pin: however the app got into "draft set, no
      // active conversation" (e.g. delete), the next creation consumes it.
      const store = useChatStore.getState()
      const firstId = store.createConversation()
      store.setDraftFilters({ feedback: { ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery'] } })
      store.deleteConversation(firstId)

      const secondId = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === secondId)
      expect(conversation?.filters.feedback.categories).toEqual(['delivery'])
      expect(useChatStore.getState().draftFilters).toEqual(EMPTY_CONVERSATION_FILTERS)
    })

    it('hands the conversation its own copy of the draft, not a shared reference', () => {
      useChatStore.getState().setDraftFilters(convWithSource('webscraper'))
      const draftBefore = useChatStore.getState().draftFilters

      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters).not.toBe(draftBefore)
      expect(conversation?.filters.feedback.sources).toEqual(['webscraper'])
    })

    it('is excluded from the persisted payload', () => {
      // A stale draft applying to a conversation created in a LATER session
      // would be the same surprising-filter-state bug in reverse — the
      // draft is ephemeral by design.
      useChatStore.getState().setDraftFilters({ feedback: EMPTY_FEEDBACK_FILTERS, useWebSearch: true })

      const options = useChatStore.persist.getOptions()
      const persisted = options.partialize?.(useChatStore.getState()) ?? useChatStore.getState()

      expect(persisted).not.toHaveProperty('draftFilters')
      expect(persisted).toHaveProperty('conversations')
      expect(persisted).toHaveProperty('activeConversationId')
    })
  })

  describe('updateConversationFilters', () => {
    it('updates conversation filters', () => {
      const { createConversation, updateConversationFilters } = useChatStore.getState()

      const convId = createConversation()
      const next: ConversationFilters = {
        feedback: { ...EMPTY_FEEDBACK_FILTERS, sources: ['webscraper'], sentiments: ['positive'] },
      }
      updateConversationFilters(convId, next)

      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.filters).toEqual(next)
    })
  })

  describe('persisted-shape migration', () => {
    it('degrades an old flat filter record to the shared empty filters without crashing', () => {
      // Issue #161 stored `{ source, category, sentiment, useWebSearch }`. The
      // merge step must read that leniently: a legacy record maps its single
      // values into the shared multi-select model.
      const migrated = useChatStore.persist.getOptions().merge?.(
        {
          conversations: [{
            id: 'conv_old',
            title: 'Legacy',
            messages: [],
            filters: { source: 'webscraper', category: 'delivery', sentiment: 'negative', useWebSearch: true },
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }],
          activeConversationId: 'conv_old',
        },
        useChatStore.getState(),
      )
      const conv = migrated?.conversations.find((c) => c.id === 'conv_old')
      expect(conv?.filters.feedback.sources).toEqual(['webscraper'])
      expect(conv?.filters.feedback.categories).toEqual(['delivery'])
      expect(conv?.filters.feedback.sentiments).toEqual(['negative'])
      expect(conv?.filters.useWebSearch).toBe(true)
    })

    it('degrades a malformed persisted filter record to empty rather than throwing', () => {
      // A corrupt `{ source: 42 }` must not crash a render — it becomes empty.
      const migrated = useChatStore.persist.getOptions().merge?.(
        {
          conversations: [{
            id: 'conv_bad', title: 'Corrupt', messages: [],
            filters: { source: 42 }, createdAt: 'x', updatedAt: 'x',
          }],
          activeConversationId: null,
        },
        useChatStore.getState(),
      )
      const conv = migrated?.conversations.find((c) => c.id === 'conv_bad')
      expect(conv?.filters.feedback).toEqual(EMPTY_FEEDBACK_FILTERS)
      expect(conv?.filters.useWebSearch).toBeUndefined()
    })

    it('keeps an already-migrated nested filter record', () => {
      const migrated = useChatStore.persist.getOptions().merge?.(
        {
          conversations: [{
            id: 'conv_new', title: 'New-shape', messages: [],
            filters: { feedback: withSource('manual_import'), useWebSearch: false },
            createdAt: 'x', updatedAt: 'x',
          }],
          activeConversationId: null,
        },
        useChatStore.getState(),
      )
      const conv = migrated?.conversations.find((c) => c.id === 'conv_new')
      expect(conv?.filters.feedback.sources).toEqual(['manual_import'])
    })
  })

  describe('getActiveConversation', () => {
    it('returns active conversation when set', () => {
      const { createConversation, getActiveConversation } = useChatStore.getState()
      
      createConversation()
      
      const conversation = useChatStore.getState().getActiveConversation()
      expect(conversation).not.toBeNull()
      expect(conversation?.title).toBe('New Conversation')
    })

    it('returns null when no active conversation', () => {
      const conversation = useChatStore.getState().getActiveConversation()
      expect(conversation).toBeNull()
    })
  })

  describe('clearAllConversations', () => {
    it('removes all conversations', () => {
      const { createConversation, clearAllConversations } = useChatStore.getState()
      
      createConversation()
      createConversation()
      clearAllConversations()
      
      const state = useChatStore.getState()
      expect(state.conversations).toHaveLength(0)
    })

    it('clears active conversation id', () => {
      const { createConversation, clearAllConversations } = useChatStore.getState()
      
      createConversation()
      clearAllConversations()
      
      const state = useChatStore.getState()
      expect(state.activeConversationId).toBeNull()
    })
  })
})
