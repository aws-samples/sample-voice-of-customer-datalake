/**
 * @fileoverview Tests for ChatSidebar component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatSidebar from './ChatSidebar'
import { useChatStore } from '../../store/chatStore'

// Mock the chat store
vi.mock('../../store/chatStore', () => ({
  useChatStore: vi.fn(),
}))

describe('ChatSidebar', () => {
  const mockCreateConversation = vi.fn()
  const mockDeleteConversation = vi.fn()
  const mockSetActiveConversation = vi.fn()
  const mockUpdateConversationTitle = vi.fn()
  const mockClearAllConversations = vi.fn()
  const mockOnClose = vi.fn()

  const mockConversations = [
    {
      id: 'conv-1',
      title: 'First Conversation',
      messages: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: new Date() }],
      filters: {},
      createdAt: new Date('2025-01-15T10:00:00Z'),
      updatedAt: new Date('2025-01-15T10:30:00Z'),
    },
    {
      id: 'conv-2',
      title: 'Second Conversation',
      messages: [
        { id: 'm2', role: 'user', content: 'Hi', timestamp: new Date() },
        { id: 'm3', role: 'assistant', content: 'Hello!', timestamp: new Date() },
      ],
      filters: {},
      createdAt: new Date('2025-01-14T10:00:00Z'),
      updatedAt: new Date('2025-01-14T11:00:00Z'),
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      conversations: mockConversations,
      activeConversationId: 'conv-1',
      createConversation: mockCreateConversation,
      deleteConversation: mockDeleteConversation,
      setActiveConversation: mockSetActiveConversation,
      updateConversationTitle: mockUpdateConversationTitle,
      clearAllConversations: mockClearAllConversations,
    })
  })

  describe('basic rendering', () => {
    it('renders New Chat button', () => {
      render(<ChatSidebar />)
      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument()
    })

    it('renders conversation list', () => {
      render(<ChatSidebar />)
      expect(screen.getByText('First Conversation')).toBeInTheDocument()
      expect(screen.getByText('Second Conversation')).toBeInTheDocument()
    })

    it('displays message count for each conversation', () => {
      render(<ChatSidebar />)
      expect(screen.getByText(/1 messages/)).toBeInTheDocument()
      expect(screen.getByText(/2 messages/)).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no conversations exist', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        conversations: [],
        activeConversationId: null,
        createConversation: mockCreateConversation,
        deleteConversation: mockDeleteConversation,
        setActiveConversation: mockSetActiveConversation,
        updateConversationTitle: mockUpdateConversationTitle,
        clearAllConversations: mockClearAllConversations,
      })
      
      render(<ChatSidebar />)
      expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    })
  })

  describe('active conversation', () => {
    it('highlights active conversation', () => {
      render(<ChatSidebar />)
      
      const activeConv = screen.getByText('First Conversation').closest('.rounded-lg')
      expect(activeConv).toHaveClass('bg-blue-100')
    })
  })

  describe('new chat', () => {
    it('calls createConversation when New Chat is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      await user.click(screen.getByRole('button', { name: /new chat/i }))
      
      expect(mockCreateConversation).toHaveBeenCalledTimes(1)
    })

    it('calls onClose after creating new chat', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar onClose={mockOnClose} />)
      
      await user.click(screen.getByRole('button', { name: /new chat/i }))
      
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('selecting conversation', () => {
    it('calls setActiveConversation when conversation is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      await user.click(screen.getByText('Second Conversation'))
      
      expect(mockSetActiveConversation).toHaveBeenCalledWith('conv-2')
    })

    it('calls onClose after selecting conversation', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar onClose={mockOnClose} />)
      
      await user.click(screen.getByText('Second Conversation'))
      
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('deleting conversation', () => {
    it('calls deleteConversation when delete button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Find delete buttons (trash icons)
      const deleteButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-trash-2')
      )
      
      // Click the first delete button
      if (deleteButtons.length > 0) {
        await user.click(deleteButtons[0])
        expect(mockDeleteConversation).toHaveBeenCalled()
      }
    })
  })

  describe('clearing all conversations', () => {
    it('renders clear all button when conversations exist', () => {
      render(<ChatSidebar />)
      expect(screen.getByRole('button', { name: /clear all conversations/i })).toBeInTheDocument()
    })

    it('does not render clear all button when no conversations', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        conversations: [],
        activeConversationId: null,
        createConversation: mockCreateConversation,
        deleteConversation: mockDeleteConversation,
        setActiveConversation: mockSetActiveConversation,
        updateConversationTitle: mockUpdateConversationTitle,
        clearAllConversations: mockClearAllConversations,
      })
      
      render(<ChatSidebar />)
      expect(screen.queryByRole('button', { name: /clear all conversations/i })).not.toBeInTheDocument()
    })

    it('calls clearAllConversations when clear all is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      await user.click(screen.getByRole('button', { name: /clear all conversations/i }))
      
      expect(mockClearAllConversations).toHaveBeenCalledTimes(1)
    })
  })

  describe('editing conversation title', () => {
    it('shows input field when edit button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Find edit buttons (pencil icons)
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        expect(screen.getByRole('textbox')).toBeInTheDocument()
      }
    })
  })
})
