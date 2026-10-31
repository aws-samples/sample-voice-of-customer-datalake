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
  selectedSentiments: [],
  onToggleSentiment: vi.fn(),
  percentages: { positive: 60, neutral: 25, negative: 15 },
}

/** The live technical_support window the owner flagged ("Somewhat negative · 71 % negative"). */
const NEGATIVE_WINDOW = { positive: 24, negative: 71, mixed: 5 }

describe('SentimentGauge', () => {
  it('says the sentiment in words with the share, not a net score', () => {
    render(<SentimentGauge {...defaultProps} />)
    expect(screen.getByTestId('sentiment-words')).toHaveTextContent('Somewhat positive')
    expect(screen.getByText('60% positive')).toBeInTheDocument()
    expect(screen.queryByText('+45')).not.toBeInTheDocument()
  })

  it('renders sentiment filter buttons', () => {
    render(<SentimentGauge {...defaultProps} />)

    expect(screen.getByRole('button', { name: /positive/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /neutral/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /negative/i })).toBeInTheDocument()
  })

  it('shows percentages on filter buttons', () => {
    render(<SentimentGauge {...defaultProps} />)

    expect(screen.getByRole('button', { name: /positive/i })).toHaveTextContent('60%')
    expect(screen.getByRole('button', { name: /neutral/i })).toHaveTextContent('25%')
    expect(screen.getByRole('button', { name: /negative/i })).toHaveTextContent('15%')
  })

  it.each([
    ['toggles a sentiment on when its chip is clicked', []],
    ['toggles a selected sentiment off with the same chip', ['positive']],
  ])('%s', async (_title, selected) => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SentimentGauge {...defaultProps} selectedSentiments={selected} onToggleSentiment={onChange} />)

    await user.click(screen.getByRole('button', { name: /positive/i }))
    expect(onChange).toHaveBeenCalledWith('positive')
  })

  it('presses every selected chip (several sentiments = any of them)', () => {
    render(<SentimentGauge {...defaultProps} selectedSentiments={['positive', 'negative']} />)

    expect(screen.getByRole('button', { name: /positive/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /negative/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('highlights active filter', () => {
    render(<SentimentGauge {...defaultProps} selectedSentiments={['negative']} />)

    const negativeButton = screen.getByRole('button', { name: /negative/i })
    // Selected legend chip = accent-subtle fill + accent ring (same selected
    // treatment as the category rows), exposed as a pressed toggle.
    expect(negativeButton).toHaveClass('bg-accent-subtle', 'text-accent-text')
    expect(negativeButton).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([
    ['positive', { positive: 80, negative: 10, neutral: 10 }, 'Mostly positive', 'positive'],
    ['negative', { positive: 10, negative: 78, neutral: 12 }, 'Mostly negative', 'negative'],
    ['balanced', { positive: 40, negative: 35, neutral: 25 }, 'Balanced', 'neutral'],
  ])('tones a %s window on the dot only, never on the words', (_name, percentages, words, tone) => {
    render(<SentimentGauge {...defaultProps} percentages={percentages} />)
    expect(screen.getByTestId('sentiment-words')).toHaveTextContent(words)
    expect(screen.getByTestId('sentiment-tone-dot')).toHaveAttribute('data-tone', tone)
    expect(screen.getByTestId('sentiment-words').className).not.toMatch(/text-sentiment-/)
  })

  // Regression (owner, /categories?category=technical_support): red "Somewhat negative"
  // sat inside the hole over the red arc, wider than the hole, cut to "Somewhat negat…".
  it('keeps only the share number inside the hole; the words sit below the arc in text-strong', () => {
    render(<SentimentGauge {...defaultProps} percentages={NEGATIVE_WINDOW} />)
    const number = screen.getByTestId('sentiment-gauge-number')
    expect(number).toHaveTextContent(/^71\s?%$/)
    expect(number).toHaveClass('text-text-strong')
    expect(number.parentElement).not.toContainElement(screen.getByTestId('sentiment-words'))
    expect(screen.getByTestId('sentiment-words')).toHaveClass('text-text-strong')
  })

  it('gives the gauge a text alternative with the words and the share', () => {
    render(<SentimentGauge {...defaultProps} percentages={NEGATIVE_WINDOW} />)
    expect(screen.getByRole('img', { name: 'Sentiment: Somewhat negative, 71% negative' })).toBeInTheDocument()
  })

  it('never truncates the words or the share line', () => {
    render(<SentimentGauge {...defaultProps} />)
    const words = screen.getByTestId('sentiment-words')
    expect(words.className).not.toMatch(/\btruncate\b|line-clamp|overflow-hidden/)
    expect(screen.getByText('60% positive').className).not.toMatch(/\btruncate\b|line-clamp/)
  })
})

// verify5/V6 item 1 (owner): at 1440 + 200 % text the 175 px card put "92 %" on the arc ends.
describe('SentimentGauge at any width and text size', () => {
  it('sizes the hole number by the gauge box (cqi, capped), on one line', () => {
    render(<SentimentGauge {...defaultProps} percentages={NEGATIVE_WINDOW} />)
    const number = screen.getByTestId('sentiment-gauge-number')
    expect(number).toHaveClass('text-[length:min(1.25rem,13cqi)]', 'whitespace-nowrap')
    expect(number.parentElement).toHaveClass('@container')
  })

  it('wraps long chip labels inside the chip and spells the percent for the locale', () => {
    render(<SentimentGauge {...defaultProps} />)
    const chip = screen.getByRole('button', { name: /neutral/i })
    expect(chip).toHaveClass('max-w-full')
    expect(chip).toHaveTextContent('25%')
    expect(screen.getByText('Neutral').className).not.toMatch(/whitespace-nowrap|\btruncate\b/)
  })

  it('titles a scoped gauge with its category and shows a skeleton while it loads', () => {
    render(<SentimentGauge {...defaultProps} scopeLabel="Technical Support" isLoading />)
    expect(screen.getByRole('heading', { name: 'Sentiment · Technical Support' })).toBeInTheDocument()
    expect(screen.getByTestId('sentiment-gauge-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('sentiment-gauge')).not.toBeInTheDocument()
  })
})
