import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WordCloudCard } from './WordCloudCard'
import { keywordFontPx } from './keywordSize'
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
    expect(deliveryButton).toHaveClass('bg-accent', 'text-accent-fg')
  })

  it('does not highlight keywords when the search text differs', () => {
    render(<WordCloudCard {...defaultProps} searchText="something else" />)

    const deliveryButton = screen.getByText('delivery')
    expect(deliveryButton).not.toHaveClass('bg-accent')
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

// Design audit D-TYPE: the rarest keywords rendered at 10.4px, between scale steps.
describe('keywordFontPx', () => {
  const TYPE_SCALE = [12, 13, 14, 16, 18, 20]

  it.each([[1, 1000], [0, 10], [5, 10], [10, 10], [37, 50]])('count %i of %i lands on the type scale, never below 12px', (count, max) => {
    const px = keywordFontPx(count, max)
    expect(TYPE_SCALE).toContain(px)
    expect(px).toBeGreaterThanOrEqual(12)
  })

  it('the top keyword is the largest step and size grows with count', () => {
    expect(keywordFontPx(50, 50)).toBe(20)
    expect(keywordFontPx(20, 50)).toBeLessThan(keywordFontPx(50, 50))
  })

  it('renders every keyword button at a pixel size from the scale', () => {
    render(<WordCloudCard {...defaultProps} wordCloudData={[{ word: 'rare', count: 1 }, { word: 'common', count: 1000 }]} />)
    expect(screen.getByRole('button', { name: 'rare' }).style.fontSize).toBe('12px')
    expect(screen.getByRole('button', { name: 'common' }).style.fontSize).toBe('20px')
  })
})
