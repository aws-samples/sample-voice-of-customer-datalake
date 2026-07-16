import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CategoriesPDFContent, { type CategoriesPDFProps } from './CategoriesPDFContent'

function makeProps(overrides: Partial<CategoriesPDFProps> = {}): CategoriesPDFProps {
  return {
    categoryData: [{ name: 'delivery', value: 12, color: '#ff0000' }],
    sentimentData: [{ name: 'positive', value: 8, percentage: 67, color: '#00ff00' }],
    wordCloudData: [{ word: 'refund', count: 5 }],
    totalIssues: 20,
    avgSentiment: 15,
    timeRange: 'Last 7 days',
    selectedSource: null,
    ...overrides,
  }
}

describe('CategoriesPDFContent', () => {
  it('renders category names from categoryData', () => {
    render(<CategoriesPDFContent {...makeProps()} />)
    expect(screen.getByText('delivery')).toBeInTheDocument()
  })

  it('renders keyword cloud words', () => {
    render(<CategoriesPDFContent {...makeProps({ wordCloudData: [{ word: 'shipping', count: 9 }] })} />)
    expect(screen.getByText(/shipping/)).toBeInTheDocument()
  })

  it('renders the total issues count', () => {
    render(<CategoriesPDFContent {...makeProps({ totalIssues: 99 })} />)
    expect(screen.getByText('99')).toBeInTheDocument()
  })

  it('renders the selected source label when provided', () => {
    render(<CategoriesPDFContent {...makeProps({ selectedSource: 'webscraper' })} />)
    expect(screen.getByText(/webscraper/)).toBeInTheDocument()
  })

  it('appends the feedback items table when items are provided (merged report)', () => {
    render(
      <CategoriesPDFContent
        {...makeProps({
          items: [
            {
              feedback_id: 'f1',
              source_id: 's1',
              source_platform: 'webscraper',
              source_channel: 'web',
              brand_name: 'Acme',
              source_created_at: '2026-06-01T00:00:00Z',
              processed_at: '2026-06-01T01:00:00Z',
              original_text: 'Slow delivery ruined my week',
              original_language: 'en',
              category: 'delivery',
              journey_stage: 'post_purchase',
              sentiment_label: 'negative',
              sentiment_score: -0.7,
              urgency: 'high',
              impact_area: 'retention',
            },
          ],
        })}
      />
    )
    expect(screen.getByText(/Feedback Items \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('Slow delivery ruined my week')).toBeInTheDocument()
  })

  it('omits the feedback items section when no items are provided', () => {
    render(<CategoriesPDFContent {...makeProps()} />)
    expect(screen.queryByText(/Feedback Items/)).not.toBeInTheDocument()
  })
})
