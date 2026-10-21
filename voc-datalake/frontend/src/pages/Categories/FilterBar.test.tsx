import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RatingPicker, SearchBox } from './FilterBar'
import type { RatingFilter } from './types'

const ANY: RatingFilter = { value: 0, direction: 'up' }

describe('SearchBox', () => {
  it('renders a labelled search input showing the current text', () => {
    render(<SearchBox searchText="refund" onSearchChange={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search feedback...' })
    expect(input).toHaveValue('refund')
  })

  it('propagates typed search text', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    render(<SearchBox searchText="" onSearchChange={onSearchChange} />)

    await user.type(screen.getByPlaceholderText('Search feedback...'), 's')
    expect(onSearchChange).toHaveBeenCalledWith('s')
  })
})

describe('RatingPicker', () => {
  it('renders the star group and the direction radiogroup', () => {
    render(<RatingPicker ratingFilter={ANY} onRatingFilterChange={vi.fn()} />)

    expect(screen.getByRole('group', { name: /star rating/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /rating direction/i })).toBeInTheDocument()
  })

  it('sets the rating threshold from the star picker, keeping the direction', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(<RatingPicker ratingFilter={ANY} onRatingFilterChange={onRatingFilterChange} />)

    await user.click(screen.getByTitle('4+ stars'))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 4, direction: 'up' })
  })

  it('resets the rating threshold via the Any button', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(<RatingPicker ratingFilter={{ value: 3, direction: 'up' }} onRatingFilterChange={onRatingFilterChange} />)

    await user.click(screen.getByTitle('Any rating'))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 0, direction: 'up' })
  })

  it('switches the direction to & below, keeping the threshold', async () => {
    const user = userEvent.setup()
    const onRatingFilterChange = vi.fn()
    render(<RatingPicker ratingFilter={{ value: 3, direction: 'up' }} onRatingFilterChange={onRatingFilterChange} />)

    await user.click(screen.getByRole('radio', { name: '& below' }))
    expect(onRatingFilterChange).toHaveBeenCalledWith({ value: 3, direction: 'below' })
  })

  it('marks the active direction as checked and flips star tooltips', () => {
    render(<RatingPicker ratingFilter={{ value: 3, direction: 'below' }} onRatingFilterChange={vi.fn()} />)

    expect(screen.getByRole('radio', { name: '& below' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '& up' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTitle('3 stars or fewer')).toBeInTheDocument()
  })

  it('moves the selection with arrow keys and keeps only the checked option tabbable', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [ratingFilter, setRatingFilter] = useState<RatingFilter>({ value: 3, direction: 'up' })
      return <RatingPicker ratingFilter={ratingFilter} onRatingFilterChange={setRatingFilter} />
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
})
