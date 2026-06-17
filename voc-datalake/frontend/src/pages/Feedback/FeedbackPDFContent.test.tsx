import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FeedbackPDFContent, { type FeedbackPDFProps } from './FeedbackPDFContent'
import type { FeedbackItem } from '../../api/types'

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    feedback_id: 'f1',
    source_id: 's1',
    source_platform: 'app_store',
    source_channel: 'ios',
    brand_name: 'Acme',
    source_created_at: '2026-06-01T00:00:00Z',
    processed_at: '2026-06-01T01:00:00Z',
    original_text: 'The checkout flow is broken',
    original_language: 'en',
    category: 'checkout_flow',
    journey_stage: 'purchase',
    sentiment_label: 'negative',
    sentiment_score: -0.8,
    urgency: 'high',
    impact_area: 'conversion',
    ...overrides,
  }
}

describe('FeedbackPDFContent', () => {
  it('renders the feedback original text', () => {
    render(<FeedbackPDFContent items={[makeItem()]} timeRange="Last 7 days" />)
    expect(screen.getByText('The checkout flow is broken')).toBeInTheDocument()
  })

  it('humanizes the source platform (underscores to spaces)', () => {
    render(<FeedbackPDFContent items={[makeItem({ source_platform: 'app_store' })]} timeRange="Last 7 days" />)
    expect(screen.getByText('app store')).toBeInTheDocument()
  })

  it('shows rating as N/5 when present', () => {
    render(<FeedbackPDFContent items={[makeItem({ rating: 2 })]} timeRange="Last 7 days" />)
    expect(screen.getByText('2/5')).toBeInTheDocument()
  })

  it('renders an em dash when rating is absent', () => {
    render(<FeedbackPDFContent items={[makeItem({ rating: undefined })]} timeRange="Last 7 days" />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('renders multiple feedback rows', () => {
    render(
      <FeedbackPDFContent
        items={[
          makeItem({ feedback_id: 'a', original_text: 'First complaint' }),
          makeItem({ feedback_id: 'b', original_text: 'Second complaint' }),
        ]}
        timeRange="Last 7 days"
      />
    )
    expect(screen.getByText('First complaint')).toBeInTheDocument()
    expect(screen.getByText('Second complaint')).toBeInTheDocument()
  })

  it('renders when sentiment_score arrives as a string (API string-typed Decimal)', () => {
    // Regression: the /feedback API can return sentiment_score as a JSON string
    // for records persisted as DynamoDB String attributes. Calling .toFixed()
    // on a string previously threw and produced a blank PDF window.
    const stringScoreItem = makeItem({
      original_text: 'Manual import review',
      // Cast through unknown: the runtime value violates the declared number type.
      sentiment_score: '0.9' as unknown as number,
    })
    expect(() =>
      render(<FeedbackPDFContent items={[stringScoreItem]} timeRange="Last 7 days" />)
    ).not.toThrow()
    expect(screen.getByText('Manual import review')).toBeInTheDocument()
    // Coerced and formatted to 2 decimals rather than crashing.
    expect(screen.getByText(/negative \(0\.90\)/)).toBeInTheDocument()
  })

  it('falls back to 0.00 when sentiment_score is not numeric', () => {
    const badScoreItem = makeItem({
      original_text: 'Garbage score review',
      sentiment_score: 'not-a-number' as unknown as number,
    })
    expect(() =>
      render(<FeedbackPDFContent items={[badScoreItem]} timeRange="Last 7 days" />)
    ).not.toThrow()
    expect(screen.getByText(/negative \(0\.00\)/)).toBeInTheDocument()
  })
})
