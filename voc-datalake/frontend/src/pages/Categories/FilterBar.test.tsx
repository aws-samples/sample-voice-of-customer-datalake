import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilterBar } from './FilterBar'

const defaultProps = {
  searchText: '',
  onSearchChange: vi.fn(),
  selectedSource: null as string | null,
  onSourceChange: vi.fn(),
  allSources: ['webscraper', 'manual_import'],
  showUrgentOnly: false,
  onUrgentChange: vi.fn(),
  minRating: 0,
  onMinRatingChange: vi.fn(),
  hasActiveFilters: false,
  onClearFilters: vi.fn(),
}

describe('FilterBar', () => {
  it('renders search input, source select, min rating and urgent toggle in one bar', () => {
    render(<FilterBar {...defaultProps} />)

    expect(screen.getByPlaceholderText('Search feedback...')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /filter by source/i })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /minimum rating/i })).toBeInTheDocument()
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

  it('sets the minimum rating from the star picker', async () => {
    const user = userEvent.setup()
    const onMinRatingChange = vi.fn()
    render(<FilterBar {...defaultProps} onMinRatingChange={onMinRatingChange} />)

    await user.click(screen.getByTitle('4+ stars'))
    expect(onMinRatingChange).toHaveBeenCalledWith(4)
  })

  it('resets the minimum rating via the Any button', async () => {
    const user = userEvent.setup()
    const onMinRatingChange = vi.fn()
    render(<FilterBar {...defaultProps} minRating={3} onMinRatingChange={onMinRatingChange} />)

    await user.click(screen.getByTitle('Any rating'))
    expect(onMinRatingChange).toHaveBeenCalledWith(0)
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
})
