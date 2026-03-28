import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategorySelector } from './CategorySelector'
import type { CategoryData, SentimentFilter } from './types'

const mockCategories: CategoryData[] = [
  { name: 'delivery', value: 50, color: '#ef4444' },
  { name: 'customer_support', value: 30, color: '#f97316' },
  { name: 'pricing', value: 20, color: '#22c55e' },
]

const defaultProps = {
  categoryData: mockCategories,
  totalIssues: 100,
  selectedCategories: [] as string[],
  onToggleCategory: vi.fn(),
  hasActiveFilters: false,
  onClearFilters: vi.fn(),
  showFilters: false,
  onToggleFilters: vi.fn(),
  minRating: 0,
  onMinRatingChange: vi.fn(),
  sentimentFilter: 'all' as SentimentFilter,
  onSentimentFilterChange: vi.fn(),
}

describe('CategorySelector', () => {
  it('renders all categories with counts and percentages', () => {
    render(<CategorySelector {...defaultProps} />)

    expect(screen.getByText('delivery')).toBeInTheDocument()
    expect(screen.getByText('50')).toBeInTheDocument()
    expect(screen.getByText('(50.0%)')).toBeInTheDocument()
  })

  it('renders remaining categories', () => {
    render(<CategorySelector {...defaultProps} />)

    expect(screen.getByText('customer support')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()

    expect(screen.getByText('pricing')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('calls onToggleCategory when category clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<CategorySelector {...defaultProps} onToggleCategory={onToggle} />)

    await user.click(screen.getByText('delivery'))
    expect(onToggle).toHaveBeenCalledWith('delivery')
  })

  it('shows clear filters button when hasActiveFilters is true', () => {
    render(<CategorySelector {...defaultProps} hasActiveFilters={true} />)
    expect(screen.getByText('Clear filters')).toBeInTheDocument()
  })

  it('hides clear filters button when hasActiveFilters is false', () => {
    render(<CategorySelector {...defaultProps} hasActiveFilters={false} />)
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument()
  })

  it('calls onClearFilters when clear button clicked', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<CategorySelector {...defaultProps} hasActiveFilters={true} onClearFilters={onClear} />)

    await user.click(screen.getByText('Clear filters'))
    expect(onClear).toHaveBeenCalledWith(expect.any(Object))
  })

  it('calls onToggleFilters when filters button clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<CategorySelector {...defaultProps} onToggleFilters={onToggle} />)

    await user.click(screen.getByRole('button', { name: /filters/i }))
    expect(onToggle).toHaveBeenCalledWith(expect.any(Object))
  })

  it('shows advanced filters when showFilters is true', () => {
    render(<CategorySelector {...defaultProps} showFilters={true} />)
    expect(screen.getByText('Min Rating')).toBeInTheDocument()
    expect(screen.getByText('Sentiment')).toBeInTheDocument()
  })

  it('hides advanced filters when showFilters is false', () => {
    render(<CategorySelector {...defaultProps} showFilters={false} />)
    expect(screen.queryByText('Min Rating')).not.toBeInTheDocument()
  })

  it('calls onMinRatingChange when rating button clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<CategorySelector {...defaultProps} showFilters={true} onMinRatingChange={onChange} />)

    await user.click(screen.getByText('Any'))
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('calls onSentimentFilterChange when sentiment select changed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<CategorySelector {...defaultProps} showFilters={true} onSentimentFilterChange={onChange} />)

    await user.selectOptions(screen.getByRole('combobox'), 'negative')
    expect(onChange).toHaveBeenCalledWith('negative')
  })

  it('highlights selected categories', () => {
    render(<CategorySelector {...defaultProps} selectedCategories={['delivery']} />)

    // eslint-disable-next-line testing-library/no-node-access
    const deliveryButton = screen.getByText('delivery').closest('button')
    expect(deliveryButton).toHaveClass('border-blue-500')
  })
})
