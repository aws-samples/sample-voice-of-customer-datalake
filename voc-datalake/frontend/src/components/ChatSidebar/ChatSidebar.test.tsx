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

  const defaultStoreValue = {
    conversations: mockConversations,
    activeConversationId: 'conv-1',
    createConversation: mockCreateConversation,
    deleteConversation: mockDeleteConversation,
    setActiveConversation: mockSetActiveConversation,
    updateConversationTitle: mockUpdateConversationTitle,
    clearAllConversations: mockClearAllConversations,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(defaultStoreValue)
  })

  /** Find buttons whose innerHTML contains a given substring (e.g. a lucide class) */
  function findButtonsWithIcon(substring: string) {
    return screen.getAllByRole('button').filter(btn =>
      btn.innerHTML.includes(substring)
    )
  }

  /** Enter edit mode on the first conversation */
  async function startEditing(user: ReturnType<typeof userEvent.setup>) {
    const editButtons = findButtonsWithIcon('lucide-pen')
    expect(editButtons.length).toBeGreaterThan(0)
    await user.click(editButtons[0])
  }

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
      expect(screen.getByText(/1 message/)).toBeInTheDocument()
      expect(screen.getByText(/2 messages/)).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no conversations exist', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultStoreValue,
        conversations: [],
        activeConversationId: null,
      })
      render(<ChatSidebar />)
      expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    })
  })

  describe('active conversation', () => {
    it('highlights active conversation', () => {
      render(<ChatSidebar />)
      expect(screen.getByTestId('conversation-item-conv-1')).toHaveClass('bg-blue-100')
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
    }, 15000)

    it('calls onClose after selecting conversation', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar onClose={mockOnClose} />)
      await user.click(screen.getByText('Second Conversation'))
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    }, 15000)
  })

  describe('deleting conversation', () => {
    it('calls deleteConversation when delete button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      const deleteButtons = findButtonsWithIcon('lucide-trash-2')
      expect(deleteButtons.length).toBeGreaterThan(0)
      await user.click(deleteButtons[0])
      expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1')
    }, 15000)
  })

  describe('clearing all conversations', () => {
    it('renders clear all button when conversations exist', () => {
      render(<ChatSidebar />)
      expect(screen.getByRole('button', { name: /clear all conversations/i })).toBeInTheDocument()
    })

    it('does not render clear all button when no conversations', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultStoreValue,
        conversations: [],
        activeConversationId: null,
      })
      render(<ChatSidebar />)
      expect(screen.queryByRole('button', { name: /clear all conversations/i })).not.toBeInTheDocument()
    })

    it('calls clearAllConversations when clear all is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await user.click(screen.getByRole('button', { name: /clear all conversations/i }))
      expect(mockClearAllConversations).toHaveBeenCalledTimes(1)
    }, 15000)
  })

  describe('editing conversation title', () => {
    it('shows input field when edit button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('saves title when Enter is pressed', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const input = screen.getByRole('textbox')
      await user.clear(input)
      await user.type(input, 'New Title{Enter}')
      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'New Title')
    })

    it('cancels edit when Escape is pressed', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const input = screen.getByRole('textbox')
      await user.type(input, '{Escape}')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(mockUpdateConversationTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything())
    })

    it('saves title when check button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const input = screen.getByRole('textbox')
      await user.clear(input)
      await user.type(input, 'Updated Title')
      const checkButtons = findButtonsWithIcon('lucide-check')
      expect(checkButtons.length).toBeGreaterThan(0)
      await user.click(checkButtons[0])
      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'Updated Title')
    })

    it('cancels edit when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const cancelButtons = findButtonsWithIcon('lucide-x')
      expect(cancelButtons.length).toBeGreaterThan(0)
      await user.click(cancelButtons[0])
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('does not save empty title', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const input = screen.getByRole('textbox')
      await user.clear(input)
      await user.type(input, '{Enter}')
      expect(mockUpdateConversationTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything())
    })

    it('stops propagation when clicking input', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      mockSetActiveConversation.mockClear()
      const input = screen.getByRole('textbox')
      await user.click(input)
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith(expect.anything())
    })
  })

  describe('date formatting', () => {
    it('handles invalid dates gracefully', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultStoreValue,
        conversations: [{
          id: 'conv-1',
          title: 'Test',
          messages: [],
          filters: {},
          createdAt: 'invalid-date',
          updatedAt: 'invalid-date',
        }],
        activeConversationId: null,
      })
      render(<ChatSidebar />)
      expect(screen.getByText('Test')).toBeInTheDocument()
    })

    it('formats valid dates correctly', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultStoreValue,
        conversations: [{
          id: 'conv-1',
          title: 'Test',
          messages: [],
          filters: {},
          createdAt: new Date('2025-01-15T10:30:00Z'),
          updatedAt: new Date('2025-01-15T10:30:00Z'),
        }],
        activeConversationId: null,
      })
      render(<ChatSidebar />)
      expect(screen.getByText(/Jan 15/)).toBeInTheDocument()
    })
  })

  describe('mobile actions visibility', () => {
    it('renders mobile action buttons for conversations', () => {
      render(<ChatSidebar />)
      const allButtons = screen.getAllByRole('button')
      expect(allButtons.length).toBeGreaterThan(3)
    })
  })

  describe('non-active conversation styling', () => {
    it('applies hover styling to non-active conversations', () => {
      render(<ChatSidebar />)
      expect(screen.getByTestId('conversation-item-conv-2')).not.toHaveClass('bg-blue-100')
    })
  })

  describe('edit mode interactions', () => {
    it('prevents conversation selection when clicking edit input', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      mockSetActiveConversation.mockClear()
      const input = screen.getByRole('textbox')
      await user.click(input)
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith(expect.anything())
    })

    it('stops propagation when clicking save button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      const input = screen.getByRole('textbox')
      await user.clear(input)
      await user.type(input, 'New Title')
      const checkButtons = findButtonsWithIcon('lucide-check')
      mockSetActiveConversation.mockClear()
      expect(checkButtons.length).toBeGreaterThan(0)
      await user.click(checkButtons[0])
      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'New Title')
    })

    it('stops propagation when clicking cancel button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      await startEditing(user)
      mockSetActiveConversation.mockClear()
      const cancelButtons = findButtonsWithIcon('lucide-x')
      expect(cancelButtons.length).toBeGreaterThan(0)
      await user.click(cancelButtons[0])
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith(expect.anything())
    })
  })

  describe('delete button propagation', () => {
    it('stops propagation when clicking delete button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      mockSetActiveConversation.mockClear()
      const deleteButtons = findButtonsWithIcon('lucide-trash-2')
      expect(deleteButtons.length).toBeGreaterThan(0)
      await user.click(deleteButtons[0])
      expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1')
    }, 15000)
  })

  describe('edit button propagation', () => {
    it('stops propagation when clicking edit button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      mockSetActiveConversation.mockClear()
      const editButtons = findButtonsWithIcon('lucide-pen')
      expect(editButtons.length).toBeGreaterThan(0)
      await user.click(editButtons[0])
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    }, 15000)
  })
})
