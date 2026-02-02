/**
 * @fileoverview Tests for chatPdfGenerator utility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Conversation } from '../../store/chatStore'

// Mock the printUtils module
const mockOpenPrintWindow = vi.fn()
vi.mock('../../utils/printUtils', () => ({
  openPrintWindow: (options: unknown) => mockOpenPrintWindow(options),
}))

// Mock react-markdown
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => children,
}))

vi.mock('remark-gfm', () => ({
  default: vi.fn(),
}))

describe('chatPdfGenerator', () => {
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

  beforeEach(() => {
    vi.clearAllMocks()
    mockOpenPrintWindow.mockReturnValue({ print: vi.fn() })
  })

  describe('generateChatPDF', () => {
    it('exports generateChatPDF function', async () => {
      const { generateChatPDF } = await import('./chatPdfGenerator')
      expect(typeof generateChatPDF).toBe('function')
    })

    it('calls openPrintWindow with correct title', async () => {
      const { generateChatPDF } = await import('./chatPdfGenerator')
      
      generateChatPDF(mockConversation)
      
      expect(mockOpenPrintWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Conversation',
        })
      )
    })

    it('passes content to openPrintWindow', async () => {
      const { generateChatPDF } = await import('./chatPdfGenerator')
      
      generateChatPDF(mockConversation)
      
      expect(mockOpenPrintWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.anything(),
        })
      )
    })

    it('throws error when print window fails to open', async () => {
      mockOpenPrintWindow.mockReturnValue(null)
      
      const { generateChatPDF } = await import('./chatPdfGenerator')
      
      expect(() => generateChatPDF(mockConversation)).toThrow(
        'Failed to open print window'
      )
    })
  })
})
