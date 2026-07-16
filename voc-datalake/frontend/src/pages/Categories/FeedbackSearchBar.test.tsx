import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeedbackSearchBar } from './FeedbackSearchBar'

const defaultProps = {
  searchText: '',
  onSearchChange: vi.fn(),
  showUrgentOnly: false,
  onUrgentChange: vi.fn(),
}

describe('FeedbackSearchBar', () => {
  it('renders the search input and urgent toggle', () => {
    render(<FeedbackSearchBar {...defaultProps} />)
    expect(screen.getByPlaceholderText('Search feedback...')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
    expect(screen.getByText('Urgent only')).toBeInTheDocument()
  })

  it('displays the current search text', () => {
    render(<FeedbackSearchBar {...defaultProps} searchText="refund" />)
    expect(screen.getByDisplayValue('refund')).toBeInTheDocument()
  })

  it('calls onSearchChange when typing', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    render(<FeedbackSearchBar {...defaultProps} onSearchChange={onSearchChange} />)

    await user.type(screen.getByPlaceholderText('Search feedback...'), 'a')
    expect(onSearchChange).toHaveBeenCalledWith('a')
  })

  it('calls onUrgentChange when the toggle is clicked', async () => {
    const user = userEvent.setup()
    const onUrgentChange = vi.fn()
    render(<FeedbackSearchBar {...defaultProps} onUrgentChange={onUrgentChange} />)

    await user.click(screen.getByRole('checkbox'))
    expect(onUrgentChange).toHaveBeenCalledWith(true)
  })

  it('reflects an active urgent toggle', () => {
    render(<FeedbackSearchBar {...defaultProps} showUrgentOnly={true} />)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })
})
