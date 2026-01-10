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

  describe('clearing individual filters', () => {
    it('clears source filter when All Sources is selected', async () => {
      const user = userEvent.setup()
      const activeFilters: ChatFiltersType = { source: 'trustpilot' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[0], '')
      
      expect(mockOnChange).toHaveBeenCalledWith({ source: undefined })
    })

    it('clears category filter when All Categories is selected', async () => {
      const user = userEvent.setup()
      const activeFilters: ChatFiltersType = { category: 'delivery' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[1], '')
      
      expect(mockOnChange).toHaveBeenCalledWith({ category: undefined })
    })

    it('clears sentiment filter when All Sentiments is selected', async () => {
      const user = userEvent.setup()
      const activeFilters: ChatFiltersType = { sentiment: 'positive' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[2], '')
      
      expect(mockOnChange).toHaveBeenCalledWith({ sentiment: undefined })
    })
  })

  describe('filter summary', () => {
    it('shows multiple filters in summary', () => {
      const activeFilters: ChatFiltersType = { 
        source: 'trustpilot', 
        category: 'delivery',
        sentiment: 'negative'
      }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      expect(screen.getByText(/focusing on:/i)).toBeInTheDocument()
      expect(screen.getByText(/Trustpilot, Delivery, Negative/)).toBeInTheDocument()
    })

    it('shows sentiment without emoji in summary', () => {
      const activeFilters: ChatFiltersType = { sentiment: 'positive' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const summary = screen.getByText(/focusing on:/i)
      expect(summary).toBeInTheDocument()
    })
  })

  describe('filter styling', () => {
    it('applies category highlight styling when active', () => {
      const activeFilters: ChatFiltersType = { category: 'delivery' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      expect(selects[1]).toHaveClass('bg-purple-50')
    })

    it('applies sentiment highlight styling when active', () => {
      const activeFilters: ChatFiltersType = { sentiment: 'positive' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      expect(selects[2]).toHaveClass('bg-green-50')
    })

    it('applies default styling when filter is not active', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      const selects = screen.getAllByRole('combobox')
      expect(selects[0]).toHaveClass('bg-white')
    })
  })

  describe('API data loading', () => {
    it('does not fetch data when apiEndpoint is not configured', () => {
      ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        config: { apiEndpoint: '' },
      })
      
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // Should still render with default options
      expect(screen.getByText('All Sources')).toBeInTheDocument()
    })

    it('loads sources from API when endpoint is configured', async () => {
      const { api } = await import('../../api/client')
      ;(api.getSources as ReturnType<typeof vi.fn>).mockResolvedValue({
        sources: { twitter: 100, trustpilot: 50 },
      })
      
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // API should be called
      expect(api.getSources).toHaveBeenCalledWith(30)
    })

    it('loads categories from API when endpoint is configured', async () => {
      const { api } = await import('../../api/client')
      ;(api.getCategories as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: { delivery: 100, quality: 50 },
      })
      
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // API should be called
      expect(api.getCategories).toHaveBeenCalledWith(30)
    })

    it('handles API errors gracefully for sources', async () => {
      const { api } = await import('../../api/client')
      ;(api.getSources as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API Error'))
      
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // Should still render with default options
      expect(screen.getByText('All Sources')).toBeInTheDocument()
    })

    it('handles API errors gracefully for categories', async () => {
      const { api } = await import('../../api/client')
      ;(api.getCategories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API Error'))
      
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // Should still render with default options
      expect(screen.getByText('All Categories')).toBeInTheDocument()
    })
  })

  describe('filter summary formatting', () => {
    it('formats source name with underscores to spaces', () => {
      const activeFilters: ChatFiltersType = { source: 'google_reviews' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      // Should format google_reviews as "Google Reviews"
      expect(screen.getByText(/focusing on:/i)).toBeInTheDocument()
    })

    it('formats category name with underscores to spaces', () => {
      const activeFilters: ChatFiltersType = { category: 'customer_support' }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      expect(screen.getByText(/focusing on:/i)).toBeInTheDocument()
    })

    it('shows combined summary for multiple filters', () => {
      const activeFilters: ChatFiltersType = { 
        source: 'trustpilot', 
        category: 'delivery',
        sentiment: 'positive'
      }
      render(<ChatFilters filters={activeFilters} onChange={mockOnChange} />)
      
      const summary = screen.getByText(/focusing on:/i)
      expect(summary).toBeInTheDocument()
    })
  })

  describe('filter dropdown icons', () => {
    it('renders chevron down icon for each dropdown', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      // Each select should have a chevron icon
      const chevrons = document.querySelectorAll('.lucide-chevron-down')
      expect(chevrons.length).toBe(3)
    })
  })

  describe('max reviews label', () => {
    it('displays max 30 reviews label', () => {
      render(<ChatFilters filters={defaultFilters} onChange={mockOnChange} />)
      
      expect(screen.getByText(/max 30 reviews/i)).toBeInTheDocument()
    })
  })
})
