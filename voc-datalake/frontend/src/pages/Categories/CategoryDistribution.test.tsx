import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient as render } from '../../test/query-client'
import userEvent from '@testing-library/user-event'
import { CategoryDistribution } from './CategoryDistribution'
import type { CategoryData } from './types'

const mockCategories: CategoryData[] = [
  { name: 'product_quality', value: 4, color: '#eab308' },
  { name: 'customer_support', value: 2, color: '#f97316' },
  { name: 'pricing', value: 2, color: '#22c55e' },
  { name: 'app', value: 2, color: '#8b5cf6' },
]

const defaultProps: ComponentProps<typeof CategoryDistribution> = {
  categoryData: mockCategories,
  totalIssues: 10,
  selectedCategories: [],
  onToggleCategory: vi.fn(),
}

describe('CategoryDistribution', () => {
  it('renders a row for each category with count and percentage', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText('Product quality')).toBeInTheDocument()
    expect(screen.getByText('4 (40%)')).toBeInTheDocument()
    // Three categories share the same 2 (20%) label
    expect(screen.getAllByText('2 (20%)')).toHaveLength(3)
  })

  it('renders the header summary with category and review counts', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText(/4 categories • 10 reviews/)).toBeInTheDocument()
  })

  // verify4: the header read "17066 items" — a bare number and a vague unit.
  it('formats a large total for the UI language, with "reviews" as the unit', () => {
    const big: CategoryData[] = [{ name: 'delivery', value: 17066, color: '#eab308' }]
    render(<CategoryDistribution {...defaultProps} categoryData={big} totalIssues={17066} />)
    expect(screen.getByText(/1 category • 17,066 reviews/)).toBeInTheDocument()
    expect(screen.getByText('17,066 (100%)')).toBeInTheDocument()
  })

  it('includes the lookback window when periodDays is provided', () => {
    render(<CategoryDistribution {...defaultProps} periodDays={7} />)

    expect(screen.getByText(/Last 7 days/)).toBeInTheDocument()
  })

  it('omits the lookback window when periodDays is not provided', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.queryByText(/Last .* days/)).not.toBeInTheDocument()
  })

  it('shows the humanised id when no category name is configured', () => {
    render(<CategoryDistribution {...defaultProps} />)

    expect(screen.getByText('Customer support')).toBeInTheDocument()
  })

  it('shows an empty state when there are no categories', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={[]} totalIssues={0} />)

    expect(screen.getByText('No categories')).toBeInTheDocument()
  })

  it('does not divide by zero when totalIssues is 0', () => {
    const single: CategoryData[] = [{ name: 'pricing', value: 0, color: '#22c55e' }]
    render(<CategoryDistribution {...defaultProps} categoryData={single} totalIssues={0} />)

    expect(screen.getByText('0 (0%)')).toBeInTheDocument()
  })

  describe('collapsed to the top 5 rows by default', () => {
    const manyCategories: CategoryData[] = [
      { name: 'other', value: 40, color: '#6b7280' },
      { name: 'app', value: 20, color: '#8b5cf6' },
      { name: 'product_quality', value: 15, color: '#eab308' },
      { name: 'pricing', value: 10, color: '#22c55e' },
      { name: 'communication', value: 7, color: '#6366f1' },
      { name: 'billing', value: 5, color: '#ec4899' },
      { name: 'website', value: 3, color: '#3b82f6' },
    ]

    it('shows only the top 5 categories when there are more', () => {
      render(<CategoryDistribution {...defaultProps} categoryData={manyCategories} totalIssues={100} />)

      expect(screen.getByText('Communication')).toBeInTheDocument() // rank 5
      expect(screen.queryByText('Billing')).not.toBeInTheDocument() // rank 6
      expect(screen.queryByText('Website')).not.toBeInTheDocument() // rank 7
    })

    it('counts the same categories in the header and the show-all toggle ("Other" is the remainder in both)', () => {
      render(<CategoryDistribution {...defaultProps} categoryData={manyCategories} totalIssues={100} />)

      expect(screen.getByText(/^6 categories/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Show all 6 categories' })).toBeInTheDocument()
    })

    it('reveals all categories via the show-all toggle and collapses back', async () => {
      const user = userEvent.setup()
      render(<CategoryDistribution {...defaultProps} categoryData={manyCategories} totalIssues={100} />)

      await user.click(screen.getByText('Show all 6 categories'))
      expect(screen.getByText('Billing')).toBeInTheDocument()
      expect(screen.getByText('Website')).toBeInTheDocument()

      await user.click(screen.getByText('Show top 5'))
      expect(screen.queryByText('Billing')).not.toBeInTheDocument()
    })

    it('keeps a selected below-the-fold category visible while collapsed (deep-link case)', () => {
      render(
        <CategoryDistribution
          {...defaultProps}
          categoryData={manyCategories}
          totalIssues={100}
          selectedCategories={['website']}
        />
      )

      expect(screen.getByText('Website')).toBeInTheDocument()
      expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Website')
      expect(screen.queryByText('Billing')).not.toBeInTheDocument() // unselected rank 6 stays hidden
    })

    it('hides the toggle when there are 5 or fewer categories', () => {
      render(<CategoryDistribution {...defaultProps} />)

      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument()
    })
  })

  describe('rows double as the category selector (issue #198 rationalization)', () => {
    it('calls onToggleCategory with the category name when a row is clicked', async () => {
      const user = userEvent.setup()
      const onToggle = vi.fn()
      render(<CategoryDistribution {...defaultProps} onToggleCategory={onToggle} />)

      await user.click(screen.getByText('Product quality'))
      expect(onToggle).toHaveBeenCalledWith('product_quality')
    })

    it('marks selected rows as pressed and highlights them', () => {
      render(<CategoryDistribution {...defaultProps} selectedCategories={['pricing']} />)

      const pricingRow = screen.getByRole('button', { pressed: true })
      expect(pricingRow).toHaveTextContent('Pricing')
      expect(pricingRow).toHaveClass('bg-accent-subtle')
    })

    it('leaves unselected rows unpressed', () => {
      render(<CategoryDistribution {...defaultProps} selectedCategories={['pricing']} />)

      const unpressed = screen.getAllByRole('button', { pressed: false })
      expect(unpressed).toHaveLength(3)
    })
  })
})

/**
 * Design audit D-14: every production category is a custom name, and all eight
 * bars fell back to the neutral grey. Colours are now assigned by rank, each row
 * carries a legend swatch in its bar's colour, and the name + count stay the
 * accessible content (the bar itself is decorative).
 */
describe('CategoryDistribution colours for custom categories (D-14)', () => {
  const custom: CategoryData[] = [
    { name: 'subscription_billing', value: 30, color: '' },
    { name: 'cartridge_quality', value: 25, color: '' },
    { name: 'app_connectivity', value: 20, color: '' },
    { name: 'shipping_delays', value: 10, color: '' },
    { name: 'customer_care', value: 8, color: '' },
    { name: 'setup_experience', value: 4, color: '' },
    { name: 'water_taste', value: 2, color: '' },
    { name: 'refunds', value: 1, color: '' },
  ]
  const colourOf = (el: HTMLElement) => el.style.backgroundColor

  async function renderExpanded() {
    const user = userEvent.setup()
    render(<CategoryDistribution {...defaultProps} categoryData={custom} totalIssues={100} />)
    await user.click(screen.getByText('Show all 8 categories'))
  }

  it('paints the top seven bars seven different ramp colours, by rank, none grey', async () => {
    await renderExpanded()
    const bars = screen.getAllByTestId('category-bar').map(colourOf)
    expect(bars).toStrictEqual([
      'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
      'var(--chart-5)', 'var(--chart-7)', 'var(--chart-8)', 'var(--chart-6)',
    ])
  })

  it('gives every row a legend swatch in its own bar colour', async () => {
    await renderExpanded()
    expect(screen.getAllByTestId('category-swatch').map(colourOf)).toStrictEqual(screen.getAllByTestId('category-bar').map(colourOf))
  })

  it('does not recolour a row when the card collapses to the top five', async () => {
    const user = userEvent.setup()
    render(<CategoryDistribution {...defaultProps} categoryData={custom} totalIssues={100} />)
    const collapsed = screen.getAllByTestId('category-bar').map(colourOf)
    await user.click(screen.getByText('Show all 8 categories'))
    expect(screen.getAllByTestId('category-bar').map(colourOf).slice(0, 5)).toStrictEqual(collapsed)
  })

  it('keeps colour from being the only cue: each row is named by its text, the bar is hidden from AT', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={custom} totalIssues={100} />)
    expect(screen.getByRole('button', { name: /subscription billing\s*30 \(30%\)/i })).toBeInTheDocument()
    for (const bar of screen.getAllByTestId('category-bar')) {
      expect(bar.closest('[aria-hidden="true"]')).not.toBeNull()
    }
    for (const swatch of screen.getAllByTestId('category-swatch')) expect(swatch).toHaveAttribute('aria-hidden', 'true')
  })
})

// verify5/V6 item 1: at 200 % text "Technical Support" overlapped "16% (41 22%)".
describe('CategoryDistribution row reflow', () => {
  it('lets the name and the counts wrap onto separate lines instead of overlapping', () => {
    render(<CategoryDistribution {...defaultProps} />)
    expect(screen.getAllByTestId('category-row-text').at(0)).toHaveClass('flex-wrap')
    expect(screen.getAllByTestId('category-row-count').at(0)).toHaveClass('whitespace-nowrap', 'ml-auto')
    const name = screen.getAllByTestId('category-swatch').at(0)?.nextElementSibling
    expect(name?.className ?? '').not.toMatch(/\btruncate\b|whitespace-nowrap/)
  })
})

// Reviews outside the configured categories are an "Other" row (shared/other_category.py).
describe('CategoryDistribution "Other" row', () => {
  const withOther: CategoryData[] = [
    { name: 'app', value: 30, color: '#8b5cf6' },
    { name: 'pricing', value: 20, color: '#22c55e' },
    { name: 'billing', value: 15, color: '#ec4899' },
    { name: 'website', value: 10, color: '#3b82f6' },
    { name: 'returns', value: 8, color: '#6366f1' },
    { name: 'delivery', value: 7, color: '#eab308' },
    { name: 'other', value: 10, color: '#5e5966' },
  ]

  it('is a translated, clickable filter row like the others', async () => {
    const user = userEvent.setup()
    const onToggleCategory = vi.fn<(category: string) => void>()
    render(<CategoryDistribution {...defaultProps} categoryData={withOther} totalIssues={100} onToggleCategory={onToggleCategory} />)
    const row = screen.getByRole('button', { name: /^Other\s*10 \(10%\)/ })
    expect(row).toHaveAttribute('title', 'Reviews of this period that no category matched')
    await user.click(row)
    expect(onToggleCategory).toHaveBeenCalledWith('other')
  })

  it('stays visible, last, while the card is collapsed to the top five', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={withOther} totalIssues={100} />)
    const names = screen.getAllByTestId('category-row-text').map((row) => row.textContent)
    expect(names).toHaveLength(6)
    expect(names.at(-1)).toMatch(/^Other/)
    expect(screen.queryByText('Delivery')).not.toBeInTheDocument()
  })

  it('is not counted as a category in the header', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={withOther} totalIssues={100} />)
    expect(screen.getByText(/^6 categories • 100 reviews/)).toBeInTheDocument()
  })

  it('is painted in the neutral step', () => {
    render(<CategoryDistribution {...defaultProps} categoryData={withOther} totalIssues={100} />)
    expect(screen.getAllByTestId('category-bar').at(-1)).toHaveStyle({ backgroundColor: 'var(--chart-6)' })
  })
})
