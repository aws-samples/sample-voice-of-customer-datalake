/**
 * @fileoverview Tests for chatStore.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'

describe('chatStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      draftFilters: {},
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
      expect(conversation?.filters).toEqual({})
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
      useChatStore.getState().setDraftFilters({ source: 'webscraper', useWebSearch: true })

      expect(useChatStore.getState().draftFilters).toEqual({ source: 'webscraper', useWebSearch: true })
    })

    it('is consumed by the next conversation, however it is created', () => {
      // Covers both entry points: the first message on the Chat page and
      // the sidebar's New Chat both go through createConversation.
      useChatStore.getState().setDraftFilters({ sentiment: 'negative' })

      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters).toEqual({ sentiment: 'negative' })
      // Draft is cleared so the NEXT fresh conversation starts clean.
      expect(useChatStore.getState().draftFilters).toEqual({})
    })

    it('creates conversations with empty filters when no draft is set', () => {
      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters).toEqual({})
    })

    it('consumes a lingering draft even after the active conversation was deleted', () => {
      // Store-level lifecycle pin: however the app got into "draft set, no
      // active conversation" (e.g. delete), the next creation consumes it.
      const store = useChatStore.getState()
      const firstId = store.createConversation()
      store.setDraftFilters({ category: 'delivery' })
      store.deleteConversation(firstId)

      const secondId = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === secondId)
      expect(conversation?.filters).toEqual({ category: 'delivery' })
      expect(useChatStore.getState().draftFilters).toEqual({})
    })

    it('hands the conversation its own copy of the draft, not a shared reference', () => {
      useChatStore.getState().setDraftFilters({ source: 'webscraper' })
      const draftBefore = useChatStore.getState().draftFilters

      const id = useChatStore.getState().createConversation()

      const conversation = useChatStore.getState().conversations.find(c => c.id === id)
      expect(conversation?.filters).not.toBe(draftBefore)
      expect(conversation?.filters).toEqual({ source: 'webscraper' })
    })

    it('is excluded from the persisted payload', () => {
      // A stale draft applying to a conversation created in a LATER session
      // would be the same surprising-filter-state bug in reverse — the
      // draft is ephemeral by design.
      useChatStore.getState().setDraftFilters({ useWebSearch: true })

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
      updateConversationFilters(convId, { source: 'webscraper', sentiment: 'positive' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.filters).toEqual({ source: 'webscraper', sentiment: 'positive' })
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
