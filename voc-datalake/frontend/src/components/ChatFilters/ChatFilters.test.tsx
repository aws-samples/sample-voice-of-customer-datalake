/**
 * @fileoverview Tests for ChatFilters component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatFilters from './ChatFilters'
import type { ChatFilters as ChatFiltersType } from '../../store/chatStore'
import { useConfigStore } from '../../store/configStore'

// Mock the config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(),
}))

// Mock the API
vi.mock('../../api/client', () => ({
  api: {
    getSources: vi.fn().mockResolvedValue({ sources: {} }),
    getCategories: vi.fn().mockResolvedValue({ categories: {} }),
  },
}))

describe('ChatFilters', () => {
  const mockOnChange = vi.fn()
  const defaultFilters: ChatFiltersType = {}

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      config: { apiEndpoint: 'https://api.example.com' },
    })
  })

  describe('basic rendering', () => {
    it('renders filter icon and label', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      expect(screen.getByText(/filter context/i)).toBeInTheDocument()
    })

    it('renders source filter dropdown', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      const selects = screen.getAllByRole('combobox')
      expect(selects.length).toBeGreaterThanOrEqual(1)
      expect(selects[0]).toBeInTheDocument()
    })

    it('renders all three filter dropdowns', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      const selects = screen.getAllByRole('combobox')
      expect(selects.length).toBe(3) // source, category, sentiment
    })
  })

  describe('source filter', () => {
    it('shows All Sources as default option', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      expect(screen.getByText('All Sources')).toBeInTheDocument()
    })

    it('calls onChange when source is selected', async () => {
      const user = userEvent.setup()
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[0], 'trustpilot')
      
      expect(mockOnChange).toHaveBeenCalledWith({ source: 'trustpilot' })
    })
  })

  describe('category filter', () => {
    it('shows All Categories as default option', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      expect(screen.getByText('All Categories')).toBeInTheDocument()
    })

    it('calls onChange when category is selected', async () => {
      const user = userEvent.setup()
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[1], 'delivery')
      
      expect(mockOnChange).toHaveBeenCalledWith({ category: 'delivery' })
    })
  })

  describe('sentiment filter', () => {
    it('shows All Sentiments as default option', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      expect(screen.getByText('All Sentiments')).toBeInTheDocument()
    })

    it('shows sentiment options with emojis', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      expect(screen.getByText('😊 Positive')).toBeInTheDocument()
      expect(screen.getByText('😐 Neutral')).toBeInTheDocument()
      expect(screen.getByText('😞 Negative')).toBeInTheDocument()
      expect(screen.getByText('🤔 Mixed')).toBeInTheDocument()
    })

    it('calls onChange when sentiment is selected', async () => {
      const user = userEvent.setup()
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[2], 'positive')
      
      expect(mockOnChange).toHaveBeenCalledWith({ sentiment: 'positive' })
    })
  })

  describe('active filters', () => {
    it('shows Clear button when filters are active', () => {
      const activeFilters: ChatFiltersType = { source: 'trustpilot' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
    })

    it('does not show Clear button when no filters are active', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
    })

    it('clears all filters when Clear is clicked', async () => {
      const user = userEvent.setup()
      const activeFilters: ChatFiltersType = { source: 'trustpilot', category: 'delivery' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      await user.click(screen.getByRole('button', { name: /clear/i }))
      
      expect(mockOnChange).toHaveBeenCalledWith({})
    })

    it('shows active filters summary', () => {
      const activeFilters: ChatFiltersType = { source: 'trustpilot' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      expect(screen.getByText(/focusing on:/i)).toBeInTheDocument()
    })

    it('applies highlight styling to active filter dropdowns', () => {
      const activeFilters: ChatFiltersType = { source: 'trustpilot' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      expect(selects[0]).toHaveClass('bg-blue-50')
    })
  })

  describe('preserving existing filters', () => {
    it('preserves other filters when updating one', async () => {
      const user = userEvent.setup()
      const activeFilters: ChatFiltersType = { source: 'trustpilot' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[1], 'delivery')
      
      expect(mockOnChange).toHaveBeenCalledWith({ source: 'trustpilot', category: 'delivery' })
    })
  })
})
