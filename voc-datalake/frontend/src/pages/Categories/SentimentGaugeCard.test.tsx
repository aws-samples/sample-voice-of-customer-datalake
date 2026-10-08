import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rechartsStubModule } from './categories-fixtures'
import { SentimentGauge } from './SentimentGaugeCard'
import type { SentimentData } from './types'

// Mock recharts to avoid rendering issues in tests
vi.mock('recharts', () => rechartsStubModule())

const mockSentimentData: SentimentData[] = [
  { name: 'positive', value: 60, color: '#22c55e', percentage: 60 },
  { name: 'neutral', value: 25, color: '#6b7280', percentage: 25 },
  { name: 'negative', value: 15, color: '#ef4444', percentage: 15 },
]

const defaultProps: ComponentProps<typeof SentimentGauge> = {
  sentimentData: mockSentimentData,
  avgSentiment: 45,
  sentimentFilter: 'all',
  onSentimentFilterChange: vi.fn(),
  percentages: { positive: 60, neutral: 25, negative: 15 },
}

describe('SentimentGauge', () => {
  it('renders sentiment score', () => {
    render(<SentimentGauge {...defaultProps} />)
    expect(screen.getByText('+45')).toBeInTheDocument()
    expect(screen.getByText('Net Sentiment')).toBeInTheDocument()
  })

  it('renders negative sentiment score without plus sign', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={-20} />)
    expect(screen.getByText('-20')).toBeInTheDocument()
  })

  it('renders sentiment filter buttons', () => {
    render(<SentimentGauge {...defaultProps} />)

    expect(screen.getByRole('button', { name: /positive/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /neutral/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /negative/i })).toBeInTheDocument()
  })

  it('shows percentages on filter buttons', () => {
    render(<SentimentGauge {...defaultProps} />)

    expect(screen.getByText('60%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('15%')).toBeInTheDocument()
  })

  it('calls onSentimentFilterChange when filter clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SentimentGauge {...defaultProps} onSentimentFilterChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /positive/i }))
    expect(onChange).toHaveBeenCalledWith('positive')
  })

  it('toggles filter off when same filter clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SentimentGauge {...defaultProps} sentimentFilter="positive" onSentimentFilterChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /positive/i }))
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('highlights active filter', () => {
    render(<SentimentGauge {...defaultProps} sentimentFilter="negative" />)

    const negativeButton = screen.getByRole('button', { name: /negative/i })
    // Selected legend chip = accent-subtle fill + accent ring (same selected
    // treatment as the category rows), exposed as a pressed toggle.
    expect(negativeButton).toHaveClass('bg-accent-subtle', 'text-accent-text')
    expect(negativeButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies green color for positive sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={50} />)
    expect(screen.getByText('+50')).toHaveClass('text-sentiment-positive')
  })

  it('applies red color for negative sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={-50} />)
    expect(screen.getByText('-50')).toHaveClass('text-sentiment-negative')
  })

  it('applies gray color for neutral sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={0} />)
    expect(screen.getByText('0')).toHaveClass('text-text')
  })
})
