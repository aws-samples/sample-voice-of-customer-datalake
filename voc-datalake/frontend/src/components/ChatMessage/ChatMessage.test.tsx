/**
 * @fileoverview Tests for ChatMessage component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ChatMessage from './ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../store/chatStore'

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

const createAssistantMessage = (
  content: string,
  sources?: ChatMessageType['sources'],
): ChatMessageType => ({
  id: 'msg-2',
  role: 'assistant',
  content,
  timestamp: new Date('2025-01-15T10:31:00Z'),
  sources,
})

describe('ChatMessage', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('user messages', () => {
    it('renders user message content', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Hello, how are you?')} />)
      expect(screen.getByText('Hello, how are you?')).toBeInTheDocument()
    })

    it('displays user avatar', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument()
    })

    it('applies user message styling (blue background)', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByTestId('chat-message-bubble')).toHaveClass('bg-blue-600', 'text-white')
    })

    it('displays timestamp', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders assistant message content', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('I can help!')} />)
      expect(screen.getByText('I can help!')).toBeInTheDocument()
    })

    it('displays bot avatar', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('Test')} />)
      expect(screen.getByTestId('assistant-avatar')).toBeInTheDocument()
    })

    it('applies assistant message styling (white background)', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('Test')} />)
      expect(screen.getByTestId('chat-message-bubble')).toHaveClass('bg-white')
    })

    it('renders markdown content', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('**Bold text** and *italic text*')} />)
      expect(screen.getByText('Bold text')).toBeInTheDocument()
      expect(screen.getByText('italic text')).toBeInTheDocument()
    })

    it('renders code blocks', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('Here is code: `const x = 1`')} />)
      expect(screen.getByText('const x = 1')).toBeInTheDocument()
    })

    it('renders lists', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('- Item 1\n- Item 2\n- Item 3')} />)
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 2')).toBeInTheDocument()
      expect(screen.getByText('Item 3')).toBeInTheDocument()
    })

    it('renders headings', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('# Main Title\n## Subtitle')} />)
      expect(screen.getByText('Main Title')).toBeInTheDocument()
      expect(screen.getByText('Subtitle')).toBeInTheDocument()
    })
  })

  describe('copy functionality', () => {
    it('copies message content when copy button is clicked', async () => {
      const user = userEvent.setup()
      renderWithRouter(<ChatMessage message={createUserMessage('Copy this text')} />)
      const copyButton = screen.getByTitle('Copy message')
      await user.click(copyButton)
      // After clicking, the check icon should appear inside the button
      expect(copyButton.innerHTML).toContain('lucide-check')
    })

    it('shows check icon after copying', async () => {
      const user = userEvent.setup()
      renderWithRouter(<ChatMessage message={createUserMessage('Copy this text')} />)
      const copyButton = screen.getByTitle('Copy message')
      // Before clicking, should show Copy icon
      expect(copyButton.innerHTML).toContain('lucide-copy')
      await user.click(copyButton)
      // After clicking, should show Check icon
      expect(copyButton.innerHTML).toContain('lucide-check')
    })
  })

  describe('source feedback carousel', () => {
    it('renders feedback carousel when sources are provided', () => {
      const sources = [{
        feedback_id: 'fb-1',
        source_id: 'src-1',
        source_platform: 'webscraper',
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
      renderWithRouter(<ChatMessage message={createAssistantMessage('Based on feedback...', sources)} />)
      expect(screen.getByText('Related feedback:')).toBeInTheDocument()
      expect(screen.getByText('Great product!')).toBeInTheDocument()
    })

    it('does not render carousel when sources are empty', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('No sources here', [])} />)
      expect(screen.queryByText('Related feedback:')).not.toBeInTheDocument()
    })

    it('does not render carousel when sources are undefined', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('No sources here')} />)
      expect(screen.queryByText('Related feedback:')).not.toBeInTheDocument()
    })
  })

  describe('markdown rendering - additional elements', () => {
    it('renders blockquotes', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('> This is a quote')} />)
      expect(screen.getByText('This is a quote')).toBeInTheDocument()
    })

    it('renders links with target blank', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('[Click here](https://example.com)')} />)
      const link = screen.getByText('Click here')
      expect(link).toHaveAttribute('href', 'https://example.com')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('renders tables', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1 | Cell 2 |')} />)
      expect(screen.getByText('Header 1')).toBeInTheDocument()
      expect(screen.getByText('Cell 1')).toBeInTheDocument()
    })

    it('renders numbered lists', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('1. First\n2. Second\n3. Third')} />)
      expect(screen.getByText('First')).toBeInTheDocument()
      expect(screen.getByText('Second')).toBeInTheDocument()
      expect(screen.getByText('Third')).toBeInTheDocument()
    })

    it('renders code blocks with language class', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('```javascript\nconst x = 1;\n```')} />)
      expect(screen.getByText('const x = 1;')).toBeInTheDocument()
    })

    it('renders h3 headings', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('### Small Heading')} />)
      expect(screen.getByText('Small Heading')).toBeInTheDocument()
    })
  })

  describe('message alignment', () => {
    it('aligns user messages to the right', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('User message')} />)
      expect(screen.getByTestId('chat-message-container')).toHaveClass('justify-end')
    })

    it('aligns assistant messages to the left', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('Assistant message')} />)
      expect(screen.getByTestId('chat-message-container')).not.toHaveClass('justify-end')
    })
  })

  describe('whitespace handling', () => {
    it('preserves whitespace in user messages', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Line 1\nLine 2\nLine 3')} />)
      expect(screen.getByText(/Line 1/)).toHaveClass('whitespace-pre-wrap')
    })
  })

  describe('copy button visibility', () => {
    it('has copy button with correct title', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByTitle('Copy message')).toBeInTheDocument()
    })

    it('copy button has opacity-0 class for hover reveal', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByTitle('Copy message')).toHaveClass('opacity-0')
    })
  })

  describe('avatar styling', () => {
    it('user avatar has correct size classes', () => {
      renderWithRouter(<ChatMessage message={createUserMessage('Test')} />)
      expect(screen.getByTestId('user-avatar')).toHaveClass('w-7', 'h-7')
    })

    it('assistant avatar has correct size classes', () => {
      renderWithRouter(<ChatMessage message={createAssistantMessage('Test')} />)
      expect(screen.getByTestId('assistant-avatar')).toHaveClass('w-7', 'h-7')
    })
  })
})
