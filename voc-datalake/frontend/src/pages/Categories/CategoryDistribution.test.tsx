import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryDistribution } from './CategoryDistribution'
import type { CategoryData } from './types'

const mockCategories: CategoryData[] = [
  { name: 'product_quality', value: 4, color: '#eab308' },
  { name: 'customer_support', value: 2, color: '#f97316' },
  { name: 'pricing', value: 2, color: '#22c55e' },
  { name: 'app', value: 2, color: '#8b5cf6' },
]

const defaultProps = {
  categoryData: mockCategories,
  totalIssues: 10,
  selectedCategories: [] as string[],
  onToggleCategory: vi.fn(),
}

describe('CategoryDistribution', () => {
  it('renders a row for each category with count and percentage', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText('product quality')).toBeInTheDocument()
    expect(screen.getByText('4 (40.0%)')).toBeInTheDocument()
    // Three categories share the same 2 (20.0%) label
    expect(screen.getAllByText('2 (20.0%)')).toHaveLength(3)
  })

  it('renders the header summary with category and item counts', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText(/4 categories • 10 items/)).toBeInTheDocument()
  })

  it('includes the lookback window when periodDays is provided', () => {
    render(<CategoryDistribution {...defaultProps} periodDays={7} />)

    expect(screen.getByText(/Last 7 days/)).toBeInTheDocument()
  })

  it('omits the lookback window when periodDays is not provided', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.queryByText(/Last .* days/)).not.toBeInTheDocument()
  })

  it('replaces underscores with spaces in category names', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText('customer support')).toBeInTheDocument()
  })

  it('shows an empty state when there are no categories', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={[]} totalIssues={0} />)

    expect(screen.getByText('No categories')).toBeInTheDocument()
  })

  it('does not divide by zero when totalIssues is 0', () => {
    const single: CategoryData[] = [{ name: 'pricing', value: 0, color: '#22c55e' }]
    render(<CategoryDistribution {...defaultProps} categoryData={single} totalIssues={0} />)

    expect(screen.getByText('0 (0.0%)')).toBeInTheDocument()
  })

  describe('rows double as the category selector (issue #198 rationalization)', () => {
    it('calls onToggleCategory with the category name when a row is clicked', async () => {
      const user = userEvent.setup()
      const onToggle = vi.fn()
      render(<CategoryDistribution {...defaultProps} onToggleCategory={onToggle} />)

      await user.click(screen.getByText('product quality'))
      expect(onToggle).toHaveBeenCalledWith('product_quality')
    })

    it('marks selected rows as pressed and highlights them', () => {
      render(<CategoryDistribution {...defaultProps} selectedCategories={['pricing']} />)

      const pricingRow = screen.getByRole('button', { pressed: true })
      expect(pricingRow).toHaveTextContent('pricing')
      expect(pricingRow).toHaveClass('bg-blue-50')
    })

    it('leaves unselected rows unpressed', () => {
      render(<CategoryDistribution {...defaultProps} selectedCategories={['pricing']} />)

      const unpressed = screen.getAllByRole('button', { pressed: false })
      expect(unpressed).toHaveLength(3)
    })
  })
})
