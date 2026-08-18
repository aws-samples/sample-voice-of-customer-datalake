import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilterBar } from './FilterBar'
import type { RatingFilter } from './types'

const defaultProps = {
  searchText: '',
  onSearchChange: vi.fn(),
  selectedSource: null as string | null,
  onSourceChange: vi.fn(),
  allSources: ['webscraper', 'manual_import'],
  showUrgentOnly: false,
  onUrgentChange: vi.fn(),
  ratingFilter: { value: 0, direction: 'up' } as RatingFilter,
  onRatingFilterChange: vi.fn(),
  hasActiveFilters: false,
  onClearFilters: vi.fn(),
}

describe('FilterBar', () => {
  it('renders search input, source select, star rating and urgent toggle in one bar', () => {
    render(<FilterBar {...defaultProps} />)

    expect(screen.getByPlaceholderText('Search feedback...')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /filter by source/i })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /star rating/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /rating direction/i })).toBeInTheDocument()
    expect(screen.getByText('Urgent only')).toBeInTheDocument()
  })

  it('propagates typed search text', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    render(<FilterBar {...defaultProps} onSearchChange={onSearchChange} />)

    await user.type(screen.getByPlaceholderText('Search feedback...'), 's')
    expect(onSearchChange).toHaveBeenCalledWith('s')
  })

  it('selects a source and maps the empty option back to null', async () => {
    const user = userEvent.setup()
    const onSourceChange = vi.fn()
    render(<FilterBar {...defaultProps} onSourceChange={onSourceChange} />)

    const select = screen.getByRole('combobox', { name: /filter by source/i })
    await user.selectOptions(select, 'webscraper')
    expect(onSourceChange).toHaveBeenCalledWith('webscraper')
  })

  it('resets the source to null when All Sources is picked', async () => {
    const user = userEvent.setup()
    const onSourceChange = vi.fn()
    render(<FilterBar {...defaultProps} selectedSource="webscraper" onSourceChange={onSourceChange} />)

    await user.selectOptions(screen.getByRole('combobox', { name: /filter by source/i }), '')
    expect(onSourceChange).toHaveBeenCalledWith(null)
  })

  it('toggles urgent-only', async () => {
    const user = userEvent.setup()
    const onUrgentChange = vi.fn()
    render(<FilterBar {...defaultProps} onUrgentChange={onUrgentChange} />)

    await user.click(screen.getByRole('checkbox'))
    expect(onUrgentChange).toHaveBeenCalledWith(true)
  })

  it('sets the rating threshold from the star picker, keeping the direction', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(<FilterBar {...defaultProps} onRatingFilterChange={onRatingFilterChange} />)

    await user.click(screen.getByTitle('4+ stars'))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 4, direction: 'up' })
  })

  it('resets the rating threshold via the Any button', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(
      <FilterBar
        {...defaultProps}
        ratingFilter={{ value: 3, direction: 'up' }}
        onRatingFilterChange={onRatingFilterChange}
      />
    )

    await user.click(screen.getByTitle('Any rating'))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 0, direction: 'up' })
  })

  it('switches the direction to & below, keeping the threshold', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(
      <FilterBar
        {...defaultProps}
        ratingFilter={{ value: 3, direction: 'up' }}
        onRatingFilterChange={onRatingFilterChange}
      />
    )

    await user.click(screen.getByRole('radio', { name: '& below' }))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 3, direction: 'below' })
  })

  it('marks the active direction as checked and flips star tooltips', () => {
    render(<FilterBar {...defaultProps} ratingFilter={{ value: 3, direction: 'below' }} />)

    expect(screen.getByRole('radio', { name: '& below' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '& up' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTitle('3 stars or fewer')).toBeInTheDocument()
  })

  it('moves the selection with arrow keys and keeps only the checked option tabbable', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [ratingFilter, setRatingFilter] = useState<RatingFilter>({ value: 3, direction: 'up' })
      return <FilterBar {...defaultProps} ratingFilter={ratingFilter} onRatingFilterChange={setRatingFilter} />
    }
    render(<Harness />)

    expect(screen.getByRole('radio', { name: '& up' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: '& below' })).toHaveAttribute('tabindex', '-1')

    screen.getByRole('radio', { name: '& up' }).focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('radio', { name: '& below' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '& below' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: '& up' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('radio', { name: '& below' })).toHaveFocus()

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: '& up' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the clear button only when filters are active and fires onClearFilters', async () => {
    const user = userEvent.setup()
    const onClearFilters = vi.fn()
    const { rerender } = render(<FilterBar {...defaultProps} onClearFilters={onClearFilters} />)

    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument()

    rerender(<FilterBar {...defaultProps} hasActiveFilters onClearFilters={onClearFilters} />)
    await user.click(screen.getByText('Clear filters'))
    expect(onClearFilters).toHaveBeenCalled()
  })

  it('renders trailing content in the bar when provided', () => {
    render(
      <FilterBar
        {...defaultProps}
        trailing={<button type="button">Export PDF</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeInTheDocument()
    expect(screen.getByTestId('filter-bar-trailing')).toBeInTheDocument()
  })

  it('omits the trailing container when no trailing content is provided', () => {
    render(<FilterBar {...defaultProps} />)

    expect(screen.queryByTestId('filter-bar-trailing')).not.toBeInTheDocument()
  })
})
