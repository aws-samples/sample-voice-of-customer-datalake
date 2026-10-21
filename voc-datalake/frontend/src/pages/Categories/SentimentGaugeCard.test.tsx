import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SentimentGauge } from './SentimentGaugeCard'
import type { SentimentData } from './types'

// Mock recharts to avoid rendering issues in tests
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}))

const mockSentimentData: SentimentData[] = [
  { name: 'positive', value: 60, color: '#22c55e', percentage: 60 },
  { name: 'neutral', value: 25, color: '#6b7280', percentage: 25 },
  { name: 'negative', value: 15, color: '#ef4444', percentage: 15 },
]

const defaultProps = {
  sentimentData: mockSentimentData,
  avgSentiment: 45,
  selectedSentiments: [],
  onToggleSentiment: vi.fn(),
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

  it('calls onToggleSentiment with the clicked sentiment', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<SentimentGauge {...defaultProps} onToggleSentiment={onToggle} />)

    await user.click(screen.getByRole('button', { name: /positive/i }))
    expect(onToggle).toHaveBeenCalledWith('positive')
  })

  it('toggles an already-selected sentiment through the same callback', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<SentimentGauge {...defaultProps} selectedSentiments={['positive']} onToggleSentiment={onToggle} />)

    await user.click(screen.getByRole('button', { name: /positive/i }))
    expect(onToggle).toHaveBeenCalledWith('positive')
  })

  it('highlights every selected sentiment and marks it pressed', () => {
    render(<SentimentGauge {...defaultProps} selectedSentiments={['negative', 'neutral']} />)

    for (const name of [/negative/i, /neutral/i]) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('bg-gray-900', 'text-white')
      expect(button).toHaveAttribute('aria-pressed', 'true')
    }
    expect(screen.getByRole('button', { name: /positive/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('applies green color for positive sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={50} />)
    expect(screen.getByText('+50')).toHaveClass('text-green-600')
  })

  it('applies red color for negative sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={-50} />)
    expect(screen.getByText('-50')).toHaveClass('text-red-600')
  })

  it('applies gray color for neutral sentiment', () => {
    render(<SentimentGauge {...defaultProps} avgSentiment={0} />)
    expect(screen.getByText('0')).toHaveClass('text-gray-600')
  })
})
