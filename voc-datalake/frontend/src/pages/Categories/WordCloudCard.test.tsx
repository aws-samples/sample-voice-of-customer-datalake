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
  selectedKeywords: [] as string[],
  onToggleKeyword: vi.fn(),
  onClearKeywords: vi.fn(),
}

describe('WordCloudCard', () => {
  it('renders all keywords', () => {
    render(<WordCloudCard {...defaultProps} />)

    expect(screen.getByText('delivery')).toBeInTheDocument()
    expect(screen.getByText('shipping')).toBeInTheDocument()
    expect(screen.getByText('support')).toBeInTheDocument()
  })

  it('calls onToggleKeyword when keyword clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<WordCloudCard {...defaultProps} onToggleKeyword={onToggle} />)

    await user.click(screen.getByText('delivery'))
    expect(onToggle).toHaveBeenCalledWith('delivery')
  })

  it('shows clear button when keywords selected', () => {
    render(<WordCloudCard {...defaultProps} selectedKeywords={['delivery']} />)
    expect(screen.getByText(/clear \(1\)/i)).toBeInTheDocument()
  })

  it('hides clear button when no keywords selected', () => {
    render(<WordCloudCard {...defaultProps} selectedKeywords={[]} />)
    expect(screen.queryByText(/clear/i)).not.toBeInTheDocument()
  })

  it('calls onClearKeywords when clear clicked', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<WordCloudCard {...defaultProps} selectedKeywords={['delivery']} onClearKeywords={onClear} />)

    await user.click(screen.getByText(/clear \(1\)/i))
    expect(onClear).toHaveBeenCalled()
  })

  it('shows filtering message when keywords selected', () => {
    render(<WordCloudCard {...defaultProps} selectedKeywords={['delivery', 'shipping']} />)
    expect(screen.getByText(/filtering by: delivery, shipping/i)).toBeInTheDocument()
  })

  it('shows empty state when no keywords', () => {
    render(<WordCloudCard {...defaultProps} wordCloudData={[]} />)
    expect(screen.getByText('No keyword data available')).toBeInTheDocument()
  })

  it('highlights selected keywords', () => {
    render(<WordCloudCard {...defaultProps} selectedKeywords={['delivery']} />)

    const deliveryButton = screen.getByText('delivery')
    expect(deliveryButton).toHaveClass('bg-blue-600', 'text-white')
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
