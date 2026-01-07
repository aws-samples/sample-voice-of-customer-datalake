/**
 * @fileoverview Tests for ChatMessage component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ChatMessage from './ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../store/chatStore'

// Helper to render with router
function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {ui}
    </MemoryRouter>
  )
}

const createUserMessage = (content: string): ChatMessageType => ({
  id: 'msg-1',
  role: 'user',
  content,
  timestamp: new Date('2025-01-15T10:30:00Z'),
})

const createAssistantMessage = (content: string, sources?: ChatMessageType['sources']): ChatMessageType => ({
  id: 'msg-2',
  role: 'assistant',
  content,
  timestamp: new Date('2025-01-15T10:31:00Z'),
  sources,
})

describe('ChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('user messages', () => {
    it('renders user message content', () => {
      const message = createUserMessage('Hello, how are you?')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Hello, how are you?')).toBeInTheDocument()
    })

    it('displays user avatar', () => {
      const message = createUserMessage('Test message')
      renderWithRouter(<ChatMessage message={message} />)
      
      // User icon should be present (gray background)
      const avatar = document.querySelector('.bg-gray-200')
      expect(avatar).toBeInTheDocument()
    })

    it('applies user message styling (blue background)', () => {
      const message = createUserMessage('Test message')
      renderWithRouter(<ChatMessage message={message} />)
      
      const messageContainer = screen.getByText('Test message').closest('.rounded-lg')
      expect(messageContainer).toHaveClass('bg-blue-600', 'text-white')
    })

    it('displays timestamp', () => {
      const message = createUserMessage('Test message')
      renderWithRouter(<ChatMessage message={message} />)
      
      // Should show time in HH:MM format
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders assistant message content', () => {
      const message = createAssistantMessage('I can help you with that!')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('I can help you with that!')).toBeInTheDocument()
    })

    it('displays bot avatar', () => {
      const message = createAssistantMessage('Test response')
      renderWithRouter(<ChatMessage message={message} />)
      
      // Bot icon should be present (blue background)
      const avatar = document.querySelector('.bg-blue-100')
      expect(avatar).toBeInTheDocument()
    })

    it('applies assistant message styling (white background)', () => {
      const message = createAssistantMessage('Test response')
      renderWithRouter(<ChatMessage message={message} />)
      
      const messageContainer = screen.getByText('Test response').closest('.rounded-lg')
      expect(messageContainer).toHaveClass('bg-white')
    })

    it('renders markdown content', () => {
      const message = createAssistantMessage('**Bold text** and *italic text*')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Bold text')).toBeInTheDocument()
      expect(screen.getByText('italic text')).toBeInTheDocument()
    })

    it('renders code blocks', () => {
      const message = createAssistantMessage('Here is code: `const x = 1`')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('const x = 1')).toBeInTheDocument()
    })

    it('renders lists', () => {
      const message = createAssistantMessage('- Item 1\n- Item 2\n- Item 3')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 2')).toBeInTheDocument()
      expect(screen.getByText('Item 3')).toBeInTheDocument()
    })

    it('renders headings', () => {
      const message = createAssistantMessage('# Main Title\n## Subtitle')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Main Title')).toBeInTheDocument()
      expect(screen.getByText('Subtitle')).toBeInTheDocument()
    })
  })

  describe('copy functionality', () => {
    it('copies message content when copy button is clicked', async () => {
      const user = userEvent.setup()
      const message = createUserMessage('Copy this text')
      renderWithRouter(<ChatMessage message={message} />)
      
      // The copy button exists but is hidden until hover - we can still click it
      const copyButton = screen.getByTitle('Copy message')
      await user.click(copyButton)
      
      // After clicking, the button should show the Check icon (indicating copy succeeded)
      // The Check icon from lucide-react has a specific class
      const checkIcon = copyButton.querySelector('.lucide-check')
      expect(checkIcon).toBeInTheDocument()
    })

    it('shows check icon after copying', async () => {
      const user = userEvent.setup()
      const message = createUserMessage('Copy this text')
      renderWithRouter(<ChatMessage message={message} />)
      
      const copyButton = screen.getByTitle('Copy message')
      
      // Before clicking, should show Copy icon
      expect(copyButton.querySelector('.lucide-copy')).toBeInTheDocument()
      
      await user.click(copyButton)
      
      // After clicking, should show Check icon
      expect(copyButton.querySelector('.lucide-check')).toBeInTheDocument()
    })
  })

  describe('source feedback carousel', () => {
    it('renders feedback carousel when sources are provided', () => {
      const sources = [{
        feedback_id: 'fb-1',
        source_id: 'src-1',
        source_platform: 'trustpilot',
        source_channel: 'reviews',
        brand_name: 'TestBrand',
        source_created_at: '2025-01-15T10:00:00Z',
        processed_at: '2025-01-15T10:05:00Z',
        original_text: 'Great product!',
        original_language: 'en',
        category: 'product_quality',
        journey_stage: 'post_purchase',
        sentiment_label: 'positive',
        sentiment_score: 0.9,
        urgency: 'low',
        impact_area: 'product',
      }]
      
      const message = createAssistantMessage('Based on feedback...', sources)
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Related feedback:')).toBeInTheDocument()
      expect(screen.getByText('Great product!')).toBeInTheDocument()
    })

    it('does not render carousel when sources are empty', () => {
      const message = createAssistantMessage('No sources here', [])
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.queryByText('Related feedback:')).not.toBeInTheDocument()
    })

    it('does not render carousel when sources are undefined', () => {
      const message = createAssistantMessage('No sources here')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.queryByText('Related feedback:')).not.toBeInTheDocument()
    })
  })

  describe('markdown rendering - additional elements', () => {
    it('renders blockquotes', () => {
      const message = createAssistantMessage('> This is a quote')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('This is a quote')).toBeInTheDocument()
    })

    it('renders links with target blank', () => {
      const message = createAssistantMessage('[Click here](https://example.com)')
      renderWithRouter(<ChatMessage message={message} />)
      
      const link = screen.getByText('Click here')
      expect(link).toHaveAttribute('href', 'https://example.com')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('renders tables', () => {
      const message = createAssistantMessage('| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1 | Cell 2 |')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Header 1')).toBeInTheDocument()
      expect(screen.getByText('Cell 1')).toBeInTheDocument()
    })

    it('renders numbered lists', () => {
      const message = createAssistantMessage('1. First\n2. Second\n3. Third')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('First')).toBeInTheDocument()
      expect(screen.getByText('Second')).toBeInTheDocument()
      expect(screen.getByText('Third')).toBeInTheDocument()
    })

    it('renders code blocks with language class', () => {
      const message = createAssistantMessage('```javascript\nconst x = 1;\n```')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('const x = 1;')).toBeInTheDocument()
    })

    it('renders h3 headings', () => {
      const message = createAssistantMessage('### Small Heading')
      renderWithRouter(<ChatMessage message={message} />)
      
      expect(screen.getByText('Small Heading')).toBeInTheDocument()
    })
  })

  describe('message alignment', () => {
    it('aligns user messages to the right', () => {
      const message = createUserMessage('User message')
      renderWithRouter(<ChatMessage message={message} />)
      
      const container = screen.getByText('User message').closest('.flex')
      expect(container).toHaveClass('justify-end')
    })

    it('aligns assistant messages to the left', () => {
      const message = createAssistantMessage('Assistant message')
      renderWithRouter(<ChatMessage message={message} />)
      
      const container = screen.getByText('Assistant message').closest('.flex')
      expect(container).not.toHaveClass('justify-end')
    })
  })

  describe('whitespace handling', () => {
    it('preserves whitespace in user messages', () => {
      const message = createUserMessage('Line 1\nLine 2\nLine 3')
      renderWithRouter(<ChatMessage message={message} />)
      
      const messageElement = screen.getByText(/Line 1/)
      expect(messageElement).toHaveClass('whitespace-pre-wrap')
    })
  })

  describe('copy button visibility', () => {
    it('has copy button with correct title', () => {
      const message = createUserMessage('Test message')
      renderWithRouter(<ChatMessage message={message} />)
      
      const copyButton = screen.getByTitle('Copy message')
      expect(copyButton).toBeInTheDocument()
    })

    it('copy button has opacity-0 class for hover reveal', () => {
      const message = createUserMessage('Test message')
      renderWithRouter(<ChatMessage message={message} />)
      
      const copyButton = screen.getByTitle('Copy message')
      expect(copyButton).toHaveClass('opacity-0')
    })
  })

  describe('avatar styling', () => {
    it('user avatar has correct size classes', () => {
      const message = createUserMessage('Test')
      renderWithRouter(<ChatMessage message={message} />)
      
      const avatar = document.querySelector('.bg-gray-200')
      expect(avatar).toHaveClass('w-7', 'h-7')
    })

    it('assistant avatar has correct size classes', () => {
      const message = createAssistantMessage('Test')
      renderWithRouter(<ChatMessage message={message} />)
      
      const avatar = document.querySelector('.bg-blue-100')
      expect(avatar).toHaveClass('w-7', 'h-7')
    })
  })
})
