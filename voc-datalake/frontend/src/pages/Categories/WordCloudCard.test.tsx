import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WordCloudCard } from './WordCloudCard'
import type { WordCloudItem } from './types'

const mockWords: WordCloudItem[] = [
  { word: 'delivery', count: 50 },
  { word: 'shipping', count: 30 },
  { word: 'support', count: 20 },
]

const defaultProps = {
  wordCloudData: mockWords,
  searchText: '',
  onSearchChange: vi.fn(),
}

describe('WordCloudCard', () => {
  it('renders all keywords', () => {
    render(<WordCloudCard {...defaultProps} />)

    expect(screen.getByText('delivery')).toBeInTheDocument()
    expect(screen.getByText('shipping')).toBeInTheDocument()
    expect(screen.getByText('support')).toBeInTheDocument()
  })

  it('populates the search box when a keyword is clicked (issue #198 rationalization)', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    render(<WordCloudCard {...defaultProps} onSearchChange={onSearchChange} />)

    await user.click(screen.getByText('delivery'))
    expect(onSearchChange).toHaveBeenCalledWith('delivery')
  })

  it('clears the search when the active keyword is clicked again', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    render(<WordCloudCard {...defaultProps} searchText="delivery" onSearchChange={onSearchChange} />)

    await user.click(screen.getByText('delivery'))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  it('highlights the keyword matching the current search text', () => {
    render(<WordCloudCard {...defaultProps} searchText="delivery" />)

    const deliveryButton = screen.getByText('delivery')
    expect(deliveryButton).toHaveClass('bg-blue-600', 'text-white')
  })

  it('does not highlight keywords when the search text differs', () => {
    render(<WordCloudCard {...defaultProps} searchText="something else" />)

    const deliveryButton = screen.getByText('delivery')
    expect(deliveryButton).not.toHaveClass('bg-blue-600')
  })

  it('shows empty state when no keywords', () => {
    render(<WordCloudCard {...defaultProps} wordCloudData={[]} />)
    expect(screen.getByText('No keyword data available')).toBeInTheDocument()
  })

  it('applies size based on count', () => {
    render(<WordCloudCard {...defaultProps} />)

    const deliveryButton = screen.getByText('delivery')
    const supportButton = screen.getByText('support')

    // Higher count = larger font
    const deliverySize = parseFloat(deliveryButton.style.fontSize)
    const supportSize = parseFloat(supportButton.style.fontSize)
    expect(deliverySize).toBeGreaterThan(supportSize)
  })
})
