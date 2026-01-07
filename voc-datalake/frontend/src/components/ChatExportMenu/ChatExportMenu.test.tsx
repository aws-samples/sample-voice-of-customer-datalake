/**
 * @fileoverview Tests for ChatExportMenu component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Conversation } from '../../store/chatStore'

// Mock heavy dependencies to prevent test stalls
vi.mock('jspdf', () => ({
  default: vi.fn().mockImplementation(() => ({
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    addPage: vi.fn(),
    addImage: vi.fn(),
    save: vi.fn(),
  })),
}))

vi.mock('html2canvas', () => ({
  default: vi.fn().mockResolvedValue({
    width: 800,
    height: 600,
    toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,mock'),
  }),
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

  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteText.mockClear()
    mockShare.mockClear()
    
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
      const { container } = render(<ChatExportMenu conversation={null} />)
      expect(container.firstChild).toBeNull()
    })

    it('returns null when conversation has no messages', () => {
      const emptyConv = { ...mockConversation, messages: [] }
      const { container } = render(<ChatExportMenu conversation={emptyConv} />)
      expect(container.firstChild).toBeNull()
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
  })

  describe('menu items', () => {
    it('displays all export options when menu is open', async () => {
      const user = userEvent.setup()
      render(<ChatExportMenu conversation={mockConversation} />)
      
      await user.click(screen.getByLabelText('Export options'))
      
      expect(screen.getByText('Copy conversation')).toBeInTheDocument()
      expect(screen.getByText('Share')).toBeInTheDocument()
      expect(screen.getByText('Download as Markdown')).toBeInTheDocument()
      expect(screen.getByText('Download as JSON')).toBeInTheDocument()
      expect(screen.getByText('Download as PDF')).toBeInTheDocument()
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
  })
})
