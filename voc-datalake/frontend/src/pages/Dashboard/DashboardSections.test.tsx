/**
 * The Dashboard's metric tiles, sentiment legend and urgent preview (wave-3 live findings):
 * a negative average never shows a trending-up or smiling icon, sentiment reads in words with
 * its share, "Sources with reviews" counts only sources that brought one, and the urgent list
 * and sentiment chips open Categories filtered.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { MetricsSummary } from '../../api/types'
import { MetricsGrid, SentimentChart, UrgentFeedback } from './DashboardSections'

vi.mock('recharts', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passThrough, PieChart: passThrough, Pie: () => null, Tooltip: () => null }
})

vi.mock('../../components/FeedbackCard/FeedbackCard', () => ({
  default: ({ feedback }: { feedback: { feedback_id: string } }) => <div>{feedback.feedback_id}</div>,
}))

const summary = (avg: number): MetricsSummary => ({
  period_days: 7, total_feedback: 100, avg_sentiment: avg, urgent_count: 12, daily_totals: [], daily_sentiment: [],
})
const breakdown = { period_days: 7, total: 100, breakdown: { positive: 12, negative: 78, neutral: 10 }, percentages: {} }

function inRouter(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

function sentimentTile(): HTMLElement {
  const card = screen.getByText('Average sentiment').closest('.card')
  if (!(card instanceof HTMLElement)) throw new Error('no sentiment tile')
  return card
}

describe('MetricsGrid', () => {
  it('says a negative average in words with its share, the number kept second', () => {
    inRouter(<MetricsGrid summary={summary(-0.78)} sentiment={breakdown} activeSources={2} />)
    const tile = within(sentimentTile())
    expect(tile.getByText('Mostly negative')).toBeInTheDocument()
    expect(tile.getByText('78% negative · \u22120.78')).toBeInTheDocument()
  })

  it('never shows a trending-up or smiling icon for a negative average', () => {
    inRouter(<MetricsGrid summary={summary(-0.78)} sentiment={breakdown} activeSources={2} />)
    const tile = sentimentTile()
    expect(tile.querySelector('.lucide-frown')).toBeInTheDocument()
    expect(tile.querySelector('.lucide-trending-up, .lucide-smile')).not.toBeInTheDocument()
  })

  it('names the sources tile by what it counts', () => {
    inRouter(<MetricsGrid summary={summary(0.2)} sentiment={breakdown} activeSources={3} />)
    expect(screen.getByText('Sources with reviews')).toBeInTheDocument()
    expect(screen.queryByText('Sources Active')).not.toBeInTheDocument()
  })
})

describe('UrgentFeedback', () => {
  it('links "See all N urgent reviews" to the Categories urgent filter', () => {
    inRouter(<UrgentFeedback items={[feedbackStub('a')]} aggregateTotal={12} />)
    expect(screen.getByRole('link', { name: /See all 12 urgent reviews/ })).toHaveAttribute('href', '/categories?urgent=1')
  })
})

describe('SentimentChart', () => {
  it('opens Categories filtered by a sentiment from its legend chip', () => {
    inRouter(<SentimentChart sentiment={breakdown} />)
    expect(screen.getByRole('link', { name: /Negative/ })).toHaveAttribute('href', '/categories?sentiment=negative')
  })
})

function feedbackStub(id: string) {
  return {
    feedback_id: id, source_id: 's', source_platform: 'webscraper', source_channel: '', brand_name: 'b',
    source_created_at: '', processed_at: '', original_text: 'x', original_language: 'en', category: 'c',
    journey_stage: '', sentiment_label: 'negative', sentiment_score: -0.5, urgency: 'high', impact_area: '',
  }
}
