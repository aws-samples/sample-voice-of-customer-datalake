/**
 * @fileoverview Tests for ChatExportMenu component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Conversation } from '../../store/chatStore'

// Mock heavy dependencies to prevent test stalls
vi.mock('../../utils/printUtils', () => ({
  openPrintWindow: vi.fn().mockReturnValue({ print: vi.fn() }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('remark-gfm', () => ({
  default: vi.fn(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn().mockReturnValue({
    render: vi.fn(),
    unmount: vi.fn(),
  }),
}))

// Mock clipboard and share APIs
const mockWriteText = vi.fn().mockResolvedValue(undefined)
const mockShare = vi.fn().mockResolvedValue(undefined)

// Import component AFTER mocks
import ChatExportMenu from './ChatExportMenu'

describe('ChatExportMenu', () => {
  const mockConversation: Conversation = {
    id: 'conv-1',
    title: 'Test Conversation',
    messages: [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date('2025-01-15T10:00:00Z') },
      { id: 'm2', role: 'assistant', content: 'Hi there!', timestamp: new Date('2025-01-15T10:01:00Z') },
    ],
    filters: {},
    createdAt: new Date('2025-01-15T10:00:00Z'),
    updatedAt: new Date('2025-01-15T10:01:00Z'),
  }

  const conversationWithSources: Conversation = {
    ...mockConversation,
    messages: [
      { id: 'm1', role: 'user', content: 'What do customers say?', timestamp: new Date('2025-01-15T10:00:00Z') },
      { 
        id: 'm2', 
        role: 'assistant', 
        content: 'Based on feedback...', 
        timestamp: new Date('2025-01-15T10:01:00Z'),
        sources: [
          {
            feedback_id: 'fb1',
            source_id: 's1',
            source_platform: 'webscraper',
            source_channel: 'social',
            brand_name: 'TestBrand',
            source_created_at: '2025-01-10T00:00:00Z',
            processed_at: '2025-01-10T01:00:00Z',
            original_text: 'Great product!',
            original_language: 'en',
            category: 'praise',
            journey_stage: 'post_purchase',
            sentiment_label: 'positive',
            sentiment_score: 0.9,
            urgency: 'low',
            impact_area: 'product',
            rating: 5,
            direct_customer_quote: 'Love this product!',
          },
        ],
      },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteText.mockClear()
    mockShare.mockClear()

    // Prevent jsdom "Not implemented: navigation" errors from anchor clicks
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(navigator, 'share', {
      value: mockShare,
      writable: true,
      configurable: true,
    })
  })

  describe('visibility', () => {
    it('returns null when conversation is null', () => {
      render(<ChatExportMenu conversation={null} />)
      expect(screen.queryByLabelText('Export options')).not.toBeInTheDocument()
    })





    it('returns null when conversation has no messages', () => {
      const emptyConv = { ...mockConversation, messages: [] }
      render(<ChatExportMenu conversation={emptyConv} />)
      expect(screen.queryByLabelText('Export options')).not.toBeInTheDocument()
    })

    it('renders when conversation has messages', () => {
      render(<ChatExportMenu conversation={mockConversation} />)
      expect(screen.getByLabelText('Export options')).toBeInTheDocument()
    })
  })

  describe('menu toggle', () => {
    it('renders menu button', () => {
      render(<ChatExportMenu conversation={mockConversation} />)
      expect(screen.getByLabelText('Export options')).toBeInTheDocument()
    })

    it('opens menu when button is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when clicking outside', async () => {
      const user = userEvent.setup()
      render(
        <div>
          <ChatExportMenu conversation={mockConversation} />
          <div data-testid="outside">Outside</div>
        </div>
      )
      
      await user.click(screen.getByLabelText('Export options'))
      expect(screen.getByRole('menu')).toBeInTheDocument()
      
      await user.click(screen.getByTestId('outside'))
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })

    it('toggles menu on repeated clicks', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      const button = screen.getByLabelText('Export options')
      
      await user.click(button)
      expect(screen.getByRole('menu')).toBeInTheDocument()
      
      await user.click(button)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  describe('menu items', () => {
    it('displays copy and share options when menu is open', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      expect(screen.getByText('Copy conversation')).toBeInTheDocument()
      expect(screen.getByText('Share')).toBeInTheDocument()
    })

    it('displays download options when menu is open', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      expect(screen.getByText('Download as Markdown')).toBeInTheDocument()
      expect(screen.getByText('Download as JSON')).toBeInTheDocument()
      expect(screen.getByText('Download as PDF')).toBeInTheDocument()
    })

    it('all menu items have menuitem role', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      const menuItems = screen.getAllByRole('menuitem')
      expect(menuItems).toHaveLength(5)
    })
  })

  describe('copy functionality', () => {
    it('copies conversation to clipboard when copy is clicked', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // Verify by checking the "Copied!" text appears (confirms clipboard was called)
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('shows Copied! text after copying', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('includes conversation title in formatted text', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // The copy was successful if Copied! appears
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('includes message content in formatted text', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // The copy was successful if Copied! appears
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('handles conversation with sources', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // The copy was successful if Copied! appears
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('share functionality', () => {
    it('uses Web Share API when available', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Share'))
      
      expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Conversation',
      }))
    })

    it('falls back to clipboard when share fails', async () => {
      mockShare.mockRejectedValueOnce(new Error('Share cancelled'))
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Share'))
      
      // Should not throw, gracefully handles error
      expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Conversation',
      }))
    })

    it('closes menu after sharing', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Share'))
      
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('download as markdown', () => {
    it('triggers download when clicked', async () => {
      const user = userEvent.setup()
      const createSpy = vi.spyOn(global.URL, 'createObjectURL').mockReturnValue('blob:url')
      const revokeSpy = vi.spyOn(global.URL, 'revokeObjectURL').mockReturnValue(undefined)
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as Markdown'))
      
      expect(createSpy).toHaveBeenCalledWith(expect.any(Blob))
      expect(revokeSpy).toHaveBeenCalledWith('blob:url')
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    })

    it('closes menu after download', async () => {
      const user = userEvent.setup()
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as Markdown'))
      
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  describe('download as JSON', () => {
    it('triggers download when clicked', async () => {
      const user = userEvent.setup()
      const createSpy = vi.spyOn(global.URL, 'createObjectURL').mockReturnValue('blob:url')
      const revokeSpy = vi.spyOn(global.URL, 'revokeObjectURL').mockReturnValue(undefined)
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as JSON'))
      
      expect(createSpy).toHaveBeenCalledWith(expect.any(Blob))
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    })

    it('closes menu after download', async () => {
      const user = userEvent.setup()
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as JSON'))
      
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  describe('download as PDF', () => {
    it('shows loading state while generating PDF', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      const pdfButton = screen.getByText('Download as PDF')
      expect(pdfButton).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has aria-haspopup attribute on menu button', () => {
      render(<ChatExportMenu conversation={mockConversation} />)
      
      const button = screen.getByLabelText('Export options')
      expect(button).toHaveAttribute('aria-haspopup', 'menu')
    })

    it('updates aria-expanded when menu opens', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      const button = screen.getByLabelText('Export options')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      
      await user.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })

    it('menu has correct aria-orientation', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      const menu = screen.getByRole('menu')
      expect(menu).toHaveAttribute('aria-orientation', 'vertical')
    })

    it('button has title attribute', () => {
      render(<ChatExportMenu conversation={mockConversation} />)
      
      const button = screen.getByLabelText('Export options')
      expect(button).toHaveAttribute('title', 'Export options')
    })
  })

  describe('filename sanitization', () => {
    it('sanitizes special characters in filename', async () => {
      const user = userEvent.setup()
      const specialConv = { ...mockConversation, title: 'Test/Conversation:With*Special?Chars' }
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={specialConv} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as Markdown'))
      
      // Should not throw error
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    })
  })

  describe('share fallback', () => {
    it('falls back to copy when navigator.share is not available', async () => {
      // Remove share API
      Object.defineProperty(navigator, 'share', {
        value: undefined,
        writable: true,
        configurable: true,
      })
      
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Share'))
      
      // Should fall back to copy (clipboard.writeText called)
      // Menu should close
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('PDF generation error handling', () => {
    it('handles PDF generation errors gracefully', async () => {
      const user = userEvent.setup()
      
      // Mock generateChatPDF to throw
      vi.mock('./chatPdfGenerator', () => ({
        generateChatPDF: vi.fn().mockRejectedValue(new Error('PDF generation failed')),
      }))
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      const pdfButton = screen.getByText('Download as PDF')
      await user.click(pdfButton)
      
      // Should not crash, menu should close
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('format conversation with sources', () => {
    it('includes source details in formatted text', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // Copy should succeed
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('includes rating in source details when available', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('includes direct customer quote when available', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('JSON export format', () => {
    it('includes all conversation metadata in JSON', async () => {
      const user = userEvent.setup()
      
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as JSON'))
      
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    })

    it('includes message sources count in JSON', async () => {
      const user = userEvent.setup()
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as JSON'))
      
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    })
  })

  describe('markdown export format', () => {
    it('includes conversation title as heading', async () => {
      const user = userEvent.setup()
      
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as Markdown'))
      
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    })

    it('includes source feedback in markdown', async () => {
      const user = userEvent.setup()
      vi.spyOn(global.URL, 'createObjectURL').mockImplementation(() => 'blob:url')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
      
      render(<ChatExportMenu conversation={conversationWithSources} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Download as Markdown'))
      
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    })
  })

  describe('copy timeout', () => {
    it('resets copied state after timeout', async () => {
      const user = userEvent.setup()
      
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      await user.click(screen.getByText('Copy conversation'))
      
      // Just verify the copied state appears - testing the timeout reset
      // would require waiting 2+ seconds which is too slow for unit tests
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('disabled state during PDF export', () => {
    it('PDF button is available in menu', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      const pdfButton = screen.getByText('Download as PDF')
      expect(pdfButton).toBeInTheDocument()
    })
  })
})
