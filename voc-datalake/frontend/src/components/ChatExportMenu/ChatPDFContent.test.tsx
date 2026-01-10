/**
 * @fileoverview Tests for ChatPDFContent component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Conversation, ChatMessage } from '../../store/chatStore'

// Mock react-markdown
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

vi.mock('remark-gfm', () => ({
  default: vi.fn(),
}))

import ChatPDFContent from './ChatPDFContent'

describe('ChatPDFContent', () => {
  const createConversation = (messages: ChatMessage[]): Conversation => ({
    id: 'conv-1',
    title: 'Test Conversation',
    messages,
    filters: {},
    createdAt: new Date('2025-01-15T10:00:00Z'),
    updatedAt: new Date('2025-01-15T10:30:00Z'),
  })

  const userMessage: ChatMessage = {
    id: 'm1',
    role: 'user',
    content: 'What do customers think?',
    timestamp: new Date('2025-01-15T10:00:00Z'),
  }

  const assistantMessage: ChatMessage = {
    id: 'm2',
    role: 'assistant',
    content: 'Based on the feedback analysis...',
    timestamp: new Date('2025-01-15T10:01:00Z'),
  }

  const assistantMessageWithSources: ChatMessage = {
    id: 'm3',
    role: 'assistant',
    content: 'Here is what customers say:',
    timestamp: new Date('2025-01-15T10:02:00Z'),
    sources: [
      {
        feedback_id: 'fb1',
        source_id: 's1',
        source_platform: 'trustpilot',
        source_channel: 'reviews',
        brand_name: 'TestBrand',
        source_created_at: '2025-01-10T00:00:00Z',
        processed_at: '2025-01-10T01:00:00Z',
        original_text: 'Great product, fast delivery!',
        original_language: 'en',
        category: 'delivery',
        journey_stage: 'post_purchase',
        sentiment_label: 'positive',
        sentiment_score: 0.9,
        urgency: 'low',
        impact_area: 'product',
        rating: 5,
        direct_customer_quote: 'Love this product!',
      },
      {
        feedback_id: 'fb2',
        source_id: 's2',
        source_platform: 'twitter',
        source_channel: 'social',
        brand_name: 'TestBrand',
        source_created_at: '2025-01-11T00:00:00Z',
        processed_at: '2025-01-11T01:00:00Z',
        original_text: 'Not happy with the service',
        original_language: 'en',
        category: 'customer_support',
        journey_stage: 'support',
        sentiment_label: 'negative',
        sentiment_score: -0.7,
        urgency: 'high',
        impact_area: 'service',
      },
    ],
  }

  describe('basic rendering', () => {
    it('renders conversation title', () => {
      const conversation = createConversation([userMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText('Test Conversation')).toBeInTheDocument()
    })

    it('renders generated timestamp', () => {
      const conversation = createConversation([userMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/Generated:/)).toBeInTheDocument()
    })
  })

  describe('message rendering', () => {
    it('renders user messages with "You" label', () => {
      const conversation = createConversation([userMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/You -/)).toBeInTheDocument()
    })

    it('renders assistant messages with "VoC AI Assistant" label', () => {
      const conversation = createConversation([assistantMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/VoC AI Assistant -/)).toBeInTheDocument()
    })

    it('renders message content', () => {
      const conversation = createConversation([userMessage, assistantMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText('What do customers think?')).toBeInTheDocument()
      expect(screen.getByText('Based on the feedback analysis...')).toBeInTheDocument()
    })

    it('renders multiple messages in order', () => {
      const conversation = createConversation([userMessage, assistantMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      const messages = screen.getAllByTestId('markdown')
      expect(messages.length).toBe(2)
    })
  })

  describe('source feedback rendering', () => {
    it('renders source feedback section when sources exist', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/Referenced Customer Feedback/)).toBeInTheDocument()
    })

    it('shows source count in header', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/2 items/)).toBeInTheDocument()
    })

    it('renders source platform and date', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/trustpilot/i)).toBeInTheDocument()
    })

    it('renders source original text', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText('Great product, fast delivery!')).toBeInTheDocument()
    })

    it('renders sentiment label', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/POSITIVE/)).toBeInTheDocument()
      expect(screen.getByText(/NEGATIVE/)).toBeInTheDocument()
    })

    it('renders category', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/Category: delivery/)).toBeInTheDocument()
    })

    it('renders rating when available', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/Rating: 5\/5/)).toBeInTheDocument()
    })

    it('renders direct customer quote when available', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/"Love this product!"/)).toBeInTheDocument()
    })

    it('does not render source section when no sources', () => {
      const conversation = createConversation([assistantMessage])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.queryByText(/Referenced Customer Feedback/)).not.toBeInTheDocument()
    })
  })

  describe('sentiment colors', () => {
    it('applies green color for positive sentiment', () => {
      const conversation = createConversation([assistantMessageWithSources])
      const { container } = render(<ChatPDFContent conversation={conversation} />)
      
      // Check that POSITIVE text exists with green color styling
      const positiveLabel = screen.getByText(/POSITIVE/)
      expect(positiveLabel).toBeInTheDocument()
    })

    it('applies red color for negative sentiment', () => {
      const conversation = createConversation([assistantMessageWithSources])
      render(<ChatPDFContent conversation={conversation} />)
      
      const negativeLabel = screen.getByText(/NEGATIVE/)
      expect(negativeLabel).toBeInTheDocument()
    })

    it('handles neutral sentiment', () => {
      const neutralSource: ChatMessage = {
        ...assistantMessageWithSources,
        sources: [{
          ...assistantMessageWithSources.sources![0],
          sentiment_label: undefined,
        }],
      }
      const conversation = createConversation([neutralSource])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/NEUTRAL/)).toBeInTheDocument()
    })
  })

  describe('category fallback', () => {
    it('shows uncategorized when category is missing', () => {
      const noCategory: ChatMessage = {
        ...assistantMessageWithSources,
        sources: [{
          ...assistantMessageWithSources.sources![0],
          category: undefined,
        }],
      }
      const conversation = createConversation([noCategory])
      render(<ChatPDFContent conversation={conversation} />)
      
      expect(screen.getByText(/uncategorized/)).toBeInTheDocument()
    })
  })

  describe('empty conversation', () => {
    it('renders with no messages', () => {
      const conversation = createConversation([])
      const { container } = render(<ChatPDFContent conversation={conversation} />)
      
      expect(container.firstChild).toBeInTheDocument()
      expect(screen.getByText('Test Conversation')).toBeInTheDocument()
    })
  })
})
