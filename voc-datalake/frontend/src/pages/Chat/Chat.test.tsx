/**
 * @fileoverview Tests for Chat page component.
 * @module pages/Chat
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock scrollIntoView for message scrolling
Element.prototype.scrollIntoView = vi.fn()

// Mock API
const mockChatStream = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    chatStream: (message: string, context?: string, days?: number) => mockChatStream(message, context, days),
  },
  getDaysFromRange: vi.fn(() => 7),
}))

// Mock config store
const mockConfigStore = vi.fn()
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => mockConfigStore(),
}))

// Mock chat store
const mockCreateConversation = vi.fn()
const mockAddMessage = vi.fn()
const mockGetActiveConversation = vi.fn()
const mockUpdateConversationFilters = vi.fn()

vi.mock('../../store/chatStore', () => ({
  useChatStore: () => ({
    activeConversationId: null,
    createConversation: mockCreateConversation,
    addMessage: mockAddMessage,
    getActiveConversation: mockGetActiveConversation,
    updateConversationFilters: mockUpdateConversationFilters,
  }),
  // Export types for the component
}))

// Mock child components
vi.mock('../../components/ChatSidebar', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="chat-sidebar">
      {onClose && <button onClick={onClose}>Close Sidebar</button>}
    </div>
  ),
}))

vi.mock('../../components/ChatMessage', () => ({
  default: ({ message }: { message: { id: string; content: string; role: string } }) => (
    <div data-testid={`message-${message.id}`} data-role={message.role}>
      {message.content}
    </div>
  ),
}))

vi.mock('../../components/ChatFilters', () => ({
  default: ({ filters, onChange }: { filters: object; onChange: (f: object) => void }) => (
    <div data-testid="chat-filters">
      <button onClick={() => onChange({ source: 'twitter' })}>Set Twitter Filter</button>
    </div>
  ),
}))

vi.mock('../../components/ChatExportMenu', () => ({
  default: ({ conversation }: { conversation: unknown }) => (
    <div data-testid="chat-export-menu">{conversation ? 'Export Available' : 'No Export'}</div>
  ),
}))

import Chat from './Chat'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/chat']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

describe('Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigStore.mockReturnValue({
      config: { apiEndpoint: 'https://api.example.com' },
      timeRange: '7d',
    })
    mockGetActiveConversation.mockReturnValue(null)
    mockCreateConversation.mockReturnValue('conv_123')
    mockChatStream.mockResolvedValue({
      response: 'AI response',
      sources: [],
    })
  })

  describe('not configured state', () => {
    it('displays configuration prompt when API endpoint not set', () => {
      mockConfigStore.mockReturnValue({
        config: { apiEndpoint: '' },
        timeRange: '7d',
      })
      
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/configure your API endpoint/i)).toBeInTheDocument()
    })
  })

  describe('initial render', () => {
    it('displays VoC AI Assistant header', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByText('VoC AI Assistant')).toBeInTheDocument()
    })

    it('displays suggested questions when no conversation', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument()
      expect(screen.getByText(/What are the top customer complaints/i)).toBeInTheDocument()
    })

    it('renders chat sidebar', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      // There may be multiple sidebars (mobile + desktop)
      const sidebars = screen.getAllByTestId('chat-sidebar')
      expect(sidebars.length).toBeGreaterThan(0)
    })

    it('renders chat filters', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('chat-filters')).toBeInTheDocument()
    })

    it('renders chat input field', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByPlaceholderText(/Ask about your feedback/i)).toBeInTheDocument()
    })

    it('renders send button', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
    })
  })

  describe('suggested questions', () => {
    it('populates input when suggested question is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      await user.click(screen.getByText(/What are the top customer complaints/i))
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      expect(input).toHaveValue('What are the top customer complaints this week?')
    })
  })

  describe('message submission', () => {
    it('creates conversation and sends message on submit', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      await user.type(input, 'What do customers think?')
      await user.click(screen.getByRole('button', { name: /send/i }))
      
      await waitFor(() => {
        expect(mockCreateConversation).toHaveBeenCalled()
        expect(mockAddMessage).toHaveBeenCalledWith('conv_123', expect.objectContaining({
          role: 'user',
          content: 'What do customers think?',
        }))
      })
    })

    it('clears input after submission', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      await user.type(input, 'Test message')
      await user.click(screen.getByRole('button', { name: /send/i }))
      
      await waitFor(() => {
        expect(input).toHaveValue('')
      })
    })

    it('disables send button when input is empty', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      const sendButton = screen.getByRole('button', { name: /send/i })
      expect(sendButton).toBeDisabled()
    })

    it('enables send button when input has text', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      await user.type(input, 'Test')
      
      const sendButton = screen.getByRole('button', { name: /send/i })
      expect(sendButton).not.toBeDisabled()
    })

    it('submits form on Enter key press', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      await user.type(input, 'Test message{enter}')
      
      await waitFor(() => {
        expect(mockAddMessage).toHaveBeenCalled()
      })
    })
  })

  describe('conversation display', () => {
    it('displays messages when conversation exists', () => {
      mockGetActiveConversation.mockReturnValue({
        id: 'conv_123',
        title: 'Test Conversation',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello', timestamp: new Date() },
          { id: 'msg_2', role: 'assistant', content: 'Hi there!', timestamp: new Date() },
        ],
        filters: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('message-msg_1')).toBeInTheDocument()
      expect(screen.getByTestId('message-msg_2')).toBeInTheDocument()
    })

    it('hides suggested questions when conversation has messages', () => {
      mockGetActiveConversation.mockReturnValue({
        id: 'conv_123',
        title: 'Test Conversation',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello', timestamp: new Date() },
        ],
        filters: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.queryByText(/Start a conversation/i)).not.toBeInTheDocument()
    })
  })

  describe('sidebar toggle', () => {
    it('toggles sidebar visibility when button is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Chat />, { wrapper: createWrapper() })
      
      // Sidebar should be visible initially - there may be multiple (mobile + desktop)
      const sidebars = screen.getAllByTestId('chat-sidebar')
      expect(sidebars.length).toBeGreaterThan(0)
      
      // Click toggle button (Hide history)
      const toggleButton = screen.getByTitle(/Hide history/i)
      await user.click(toggleButton)
      
      // After toggle, the title should change to "Show history"
      expect(screen.getByTitle(/Show history/i)).toBeInTheDocument()
    })
  })

  describe('export menu', () => {
    it('renders export menu', () => {
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('chat-export-menu')).toBeInTheDocument()
    })

    it('shows export available when conversation exists', () => {
      mockGetActiveConversation.mockReturnValue({
        id: 'conv_123',
        title: 'Test',
        messages: [{ id: 'msg_1', role: 'user', content: 'Hello', timestamp: new Date() }],
        filters: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      
      render(<Chat />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Export Available')).toBeInTheDocument()
    })
  })

  describe('error handling', () => {
    it('adds error message to conversation when API fails', async () => {
      const user = userEvent.setup()
      mockChatStream.mockRejectedValue(new Error('API Error'))
      
      render(<Chat />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Ask about your feedback/i)
      await user.type(input, 'Test message')
      await user.click(screen.getByRole('button', { name: /send/i }))
      
      await waitFor(() => {
        expect(mockAddMessage).toHaveBeenCalledWith('conv_123', expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('error'),
        }))
      })
    })
  })
})
