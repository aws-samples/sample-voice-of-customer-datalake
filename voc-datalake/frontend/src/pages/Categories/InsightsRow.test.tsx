import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InsightsRow } from './InsightsRow'
import type { CategoryData } from './types'

const mockCategories: CategoryData[] = [
  { name: 'delivery', value: 50, color: '#ef4444' },
  { name: 'customer_support', value: 30, color: '#f97316' },
  { name: 'pricing', value: 20, color: '#22c55e' },
]

describe('InsightsRow', () => {
  it('renders top issue card with correct data', () => {
    render(<InsightsRow categoryData={mockCategories} totalIssues={100} />)

    expect(screen.getByText('Top Issue')).toBeInTheDocument()
    expect(screen.getByText('delivery')).toBeInTheDocument()
    expect(screen.getByText('50 issues (50%)')).toBeInTheDocument()
  })

  it('renders least issues card with correct data', () => {
    render(<InsightsRow categoryData={mockCategories} totalIssues={100} />)

    expect(screen.getByText('Least Issues')).toBeInTheDocument()
    expect(screen.getByText('pricing')).toBeInTheDocument()
    expect(screen.getByText('20 issues')).toBeInTheDocument()
  })

  it('renders total feedback card', () => {
    render(<InsightsRow categoryData={mockCategories} totalIssues={100} />)

    expect(screen.getByText('Total Feedback')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByText('3 categories')).toBeInTheDocument()
  })

  it('handles empty category data', () => {
    render(<InsightsRow categoryData={[]} totalIssues={0} />)

    // N/A appears twice (top and bottom)
    expect(screen.getAllByText('N/A')).toHaveLength(2)
    expect(screen.getByText('0 categories')).toBeInTheDocument()
  })

  it('handles single category', () => {
    const single: CategoryData[] = [{ name: 'delivery', value: 100, color: '#ef4444' }]
    render(<InsightsRow categoryData={single} totalIssues={100} />)

    // Both top and bottom should be the same category
    expect(screen.getAllByText('delivery')).toHaveLength(2)
    expect(screen.getByText('1 categories')).toBeInTheDocument()
  })

  it('replaces underscores with spaces in category names', () => {
    const categories: CategoryData[] = [
      { name: 'customer_support', value: 50, color: '#ef4444' },
    ]
    render(<InsightsRow categoryData={categories} totalIssues={50} />)

    expect(screen.getAllByText('customer support')).toHaveLength(2)
  })
})
