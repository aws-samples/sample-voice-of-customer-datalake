import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DashboardPDFContent, { type DashboardPDFProps } from './DashboardPDFContent'

function makeProps(overrides: Partial<DashboardPDFProps> = {}): DashboardPDFProps {
  return {
    timeRange: 'Last 7 days',
    totalFeedback: 1234,
    avgSentiment: 0.45,
    urgentCount: 7,
    sourcesCount: 3,
    dailyTotals: [{ date: '2026-06-01', count: 10 }],
    sentimentBreakdown: [{ name: 'positive', value: 60 }],
    categoryBreakdown: [{ name: 'delivery', value: 12 }],
    sourceBreakdown: [{ name: 'webscraper', value: 20 }],
    urgentItems: [],
    ...overrides,
  }
}

describe('DashboardPDFContent', () => {
  it('renders the total feedback metric', () => {
    render(<DashboardPDFContent {...makeProps()} />)
    expect(screen.getByText('Total Feedback')).toBeInTheDocument()
    expect(screen.getByText('1234')).toBeInTheDocument()
  })

  it('formats average sentiment to two decimals', () => {
    render(<DashboardPDFContent {...makeProps({ avgSentiment: 0.4567 })} />)
    expect(screen.getByText('Avg Sentiment')).toBeInTheDocument()
    expect(screen.getByText('0.46')).toBeInTheDocument()
  })

  it('renders the urgent issues count', () => {
    render(<DashboardPDFContent {...makeProps({ urgentCount: 9 })} />)
    expect(screen.getByText('Urgent Issues')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
  })

  it('renders category breakdown entries', () => {
    render(<DashboardPDFContent {...makeProps({ categoryBreakdown: [{ name: 'shipping', value: 42 }] })} />)
    expect(screen.getByText('shipping')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('renders the selected time range', () => {
    render(<DashboardPDFContent {...makeProps({ timeRange: 'Last 30 days' })} />)
    expect(screen.getByText(/Last 30 days/)).toBeInTheDocument()
  })
})
