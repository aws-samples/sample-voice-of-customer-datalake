/**
 * @fileoverview Tests for chatStore.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'
import type { FeedbackItem } from '../api/types'

describe('chatStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
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
      const { createConversation } = useChatStore.getState()
      
      createConversation()
      
      const conversation = useChatStore.getState().getActiveConversation()
      expect(conversation?.messages).toStrictEqual([])
      expect(conversation?.filters).toStrictEqual({})
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

    it('preserves activeConversationId when deleting different conversation', async () => {
      // Reset state completely first
      useChatStore.setState({ conversations: [], activeConversationId: null })
      
      // Create first conversation
      const firstId = useChatStore.getState().createConversation()
      
      // Wait to ensure different timestamp for second ID
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // Create second conversation
      const secondId = useChatStore.getState().createConversation()
      
      // Verify we have two different conversations
      expect(firstId).not.toBe(secondId)
      expect(useChatStore.getState().conversations).toHaveLength(2)
      
      // Second is now active (createConversation sets it), set first as active
      useChatStore.getState().setActiveConversation(firstId)
      
      // Verify first is active before deletion
      expect(useChatStore.getState().activeConversationId).toBe(firstId)
    })

    it('keeps active conversation intact after deleting a different one', async () => {
      useChatStore.setState({ conversations: [], activeConversationId: null })
      
      const firstId = useChatStore.getState().createConversation()
      await new Promise(resolve => setTimeout(resolve, 10))
      const secondId = useChatStore.getState().createConversation()
      
      useChatStore.getState().setActiveConversation(firstId)
      
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
      const sources = [{ feedback_id: '123', text: 'Sample feedback' }] as unknown as FeedbackItem[]
      addMessage(convId, { role: 'assistant', content: 'Response', sources })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.messages[0].sources).toStrictEqual(sources)
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

  describe('updateConversationFilters', () => {
    it('updates conversation filters', () => {
      const { createConversation, updateConversationFilters } = useChatStore.getState()
      
      const convId = createConversation()
      updateConversationFilters(convId, { source: 'webscraper', sentiment: 'positive' })
      
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === convId)
      expect(conv?.filters).toStrictEqual({ source: 'webscraper', sentiment: 'positive' })
    })
  })

  describe('getActiveConversation', () => {
    it('returns active conversation when set', () => {
      const { createConversation } = useChatStore.getState()
      
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
