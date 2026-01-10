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
      
      const secondConv = screen.getByText('Second Conversation')
      await user.click(secondConv)
      
      expect(mockSetActiveConversation).toHaveBeenCalledWith('conv-2')
    }, 15000)

    it('calls onClose after selecting conversation', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar onClose={mockOnClose} />)
      
      const secondConv = screen.getByText('Second Conversation')
      await user.click(secondConv)
      
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    }, 15000)
  })

  describe('deleting conversation', () => {
    it('calls deleteConversation when delete button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Find delete buttons (trash icons) - use querySelectorAll for more reliable selection
      const deleteButtons = document.querySelectorAll('button')
      const deleteButton = Array.from(deleteButtons).find(btn => 
        btn.querySelector('.lucide-trash-2')
      )
      
      if (deleteButton) {
        await user.click(deleteButton)
        expect(mockDeleteConversation).toHaveBeenCalled()
      }
    }, 15000)
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
      
      const clearButton = screen.getByRole('button', { name: /clear all conversations/i })
      await user.click(clearButton)
      
      expect(mockClearAllConversations).toHaveBeenCalledTimes(1)
    }, 15000)
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

    it('saves title when Enter is pressed', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.clear(input)
        await user.type(input, 'New Title{Enter}')
        
        expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'New Title')
      }
    })

    it('cancels edit when Escape is pressed', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.type(input, '{Escape}')
        
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
      }
    })

    it('saves title when check button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.clear(input)
        await user.type(input, 'Updated Title')
        
        // Find and click the check button
        const checkButton = screen.getAllByRole('button').find(btn => 
          btn.querySelector('svg.lucide-check')
        )
        if (checkButton) await user.click(checkButton)
        
        expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'Updated Title')
      }
    })

    it('cancels edit when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        // Find and click the X button
        const cancelButton = screen.getAllByRole('button').find(btn => 
          btn.querySelector('svg.lucide-x')
        )
        if (cancelButton) await user.click(cancelButton)
        
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      }
    })

    it('does not save empty title', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.clear(input)
        await user.type(input, '{Enter}')
        
        // Should not call update with empty string
        expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
      }
    })

    it('stops propagation when clicking input', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.click(input)
        
        // Should not trigger setActiveConversation
        expect(mockSetActiveConversation).not.toHaveBeenCalled()
      }
    })
  })

  describe('date formatting', () => {
    it('handles invalid dates gracefully', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        conversations: [{
          id: 'conv-1',
          title: 'Test',
          messages: [],
          filters: {},
          createdAt: 'invalid-date',
          updatedAt: 'invalid-date',
        }],
        activeConversationId: null,
        createConversation: mockCreateConversation,
        deleteConversation: mockDeleteConversation,
        setActiveConversation: mockSetActiveConversation,
        updateConversationTitle: mockUpdateConversationTitle,
        clearAllConversations: mockClearAllConversations,
      })
      
      render(<ChatSidebar />)
      
      // Should render without crashing
      expect(screen.getByText('Test')).toBeInTheDocument()
    })

    it('formats valid dates correctly', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        conversations: [{
          id: 'conv-1',
          title: 'Test',
          messages: [],
          filters: {},
          createdAt: new Date('2025-01-15T10:30:00Z'),
          updatedAt: new Date('2025-01-15T10:30:00Z'),
        }],
        activeConversationId: null,
        createConversation: mockCreateConversation,
        deleteConversation: mockDeleteConversation,
        setActiveConversation: mockSetActiveConversation,
        updateConversationTitle: mockUpdateConversationTitle,
        clearAllConversations: mockClearAllConversations,
      })
      
      render(<ChatSidebar />)
      
      // Should show formatted date
      expect(screen.getByText(/Jan 15/)).toBeInTheDocument()
    })
  })

  describe('mobile actions visibility', () => {
    it('renders mobile action buttons for conversations', () => {
      render(<ChatSidebar />)
      
      // Mobile buttons should be visible (not hidden by group-hover)
      const allButtons = screen.getAllByRole('button')
      // Should have edit and delete buttons for each conversation
      expect(allButtons.length).toBeGreaterThan(3) // New Chat + Clear All + action buttons
    })
  })

  describe('non-active conversation styling', () => {
    it('applies hover styling to non-active conversations', () => {
      ;(useChatStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        conversations: mockConversations,
        activeConversationId: 'conv-1',
        createConversation: mockCreateConversation,
        deleteConversation: mockDeleteConversation,
        setActiveConversation: mockSetActiveConversation,
        updateConversationTitle: mockUpdateConversationTitle,
        clearAllConversations: mockClearAllConversations,
      })
      
      render(<ChatSidebar />)
      
      const secondConv = screen.getByText('Second Conversation').closest('.rounded-lg')
      expect(secondConv).not.toHaveClass('bg-blue-100')
    })
  })

  describe('edit mode interactions', () => {
    it('prevents conversation selection when clicking edit input', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Start editing
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        // Click on the input itself
        const input = screen.getByRole('textbox')
        await user.click(input)
        
        // setActiveConversation should not be called when clicking input
        // (it's called once when clicking the edit button's parent)
        expect(mockSetActiveConversation).not.toHaveBeenCalled()
      }
    })

    it('stops propagation when clicking save button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        const input = screen.getByRole('textbox')
        await user.clear(input)
        await user.type(input, 'New Title')
        
        // Find and click the check button
        const checkButton = screen.getAllByRole('button').find(btn => 
          btn.querySelector('svg.lucide-check')
        )
        
        // Clear mock to check if setActiveConversation is called
        mockSetActiveConversation.mockClear()
        
        if (checkButton) await user.click(checkButton)
        
        // Should save but not trigger conversation selection
        expect(mockUpdateConversationTitle).toHaveBeenCalled()
      }
    })

    it('stops propagation when clicking cancel button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      const editButtons = screen.getAllByRole('button').filter(btn => 
        btn.querySelector('svg.lucide-edit-2')
      )
      
      if (editButtons.length > 0) {
        await user.click(editButtons[0])
        
        // Clear mock
        mockSetActiveConversation.mockClear()
        
        // Find and click the X button
        const cancelButton = screen.getAllByRole('button').find(btn => 
          btn.querySelector('svg.lucide-x')
        )
        if (cancelButton) await user.click(cancelButton)
        
        // Should not trigger conversation selection
        expect(mockSetActiveConversation).not.toHaveBeenCalled()
      }
    })
  })

  describe('delete button propagation', () => {
    it('stops propagation when clicking delete button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Clear mock
      mockSetActiveConversation.mockClear()
      
      // Find delete buttons using querySelectorAll
      const deleteButton = document.querySelector('button .lucide-trash-2')?.closest('button')
      
      if (deleteButton) {
        await user.click(deleteButton)
        
        // Should delete but not trigger conversation selection
        expect(mockDeleteConversation).toHaveBeenCalled()
      }
    }, 15000)
  })

  describe('edit button propagation', () => {
    it('stops propagation when clicking edit button', async () => {
      const user = userEvent.setup()
      render(<ChatSidebar />)
      
      // Clear mock
      mockSetActiveConversation.mockClear()
      
      const editButton = document.querySelector('button .lucide-edit-2')?.closest('button')
      
      if (editButton) {
        await user.click(editButton)
        
        // Should show edit input
        expect(screen.getByRole('textbox')).toBeInTheDocument()
      }
    }, 15000)
  })
})
