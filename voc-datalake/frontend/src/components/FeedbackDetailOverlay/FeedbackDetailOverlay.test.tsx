import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { FeedbackItem } from '../../api/client'
import FeedbackDetailOverlay from '.'

const ITEM: FeedbackItem = {
  feedback_id: 'fb-42',
  source_id: 's-42',
  source_platform: 'manual_import',
  source_channel: 'csv',
  brand_name: 'Acme',
  source_created_at: '2026-07-01T10:00:00Z',
  processed_at: '2026-07-01T11:00:00Z',
  original_text: 'The parcel arrived two weeks late.',
  original_language: 'en',
  category: 'delivery',
  subcategory: 'late_delivery',
  journey_stage: 'fulfilment',
  sentiment_label: 'negative',
  sentiment_score: -0.8,
  urgency: 'high',
  impact_area: 'operations',
  rating: 2,
  problem_summary: 'Late delivery',
  problem_root_cause_hypothesis: 'Carrier backlog',
  source_url: 'https://reviews.example.com/42',
  enrichment: { usefulness: 'high' },
}

function renderOverlay(feedback: FeedbackItem | null, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <FeedbackDetailOverlay feedback={feedback} onClose={onClose} />
    </MemoryRouter>
  )
  return onClose
}

describe('FeedbackDetailOverlay', () => {
  it('renders nothing while no item is open', () => {
    renderOverlay(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the item in a dialog named by its source', () => {
    renderOverlay(ITEM)

    expect(screen.getByRole('dialog', { name: 'manual import' })).toBeInTheDocument()
    expect(screen.getByText('The parcel arrived two weeks late.')).toBeInTheDocument()
    expect(screen.getByLabelText('2 / 5')).toBeInTheDocument()
    expect(screen.getByText('late delivery')).toBeInTheDocument()
    expect(screen.getByText('Usefulness: High')).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })

  it('shows the problem and root cause analysis', () => {
    renderOverlay(ITEM)
    expect(screen.getByText('Issue:').parentElement).toHaveTextContent('Issue: Late delivery')
    expect(screen.getByText('Root cause:').parentElement).toHaveTextContent('Root cause: Carrier backlog')
  })

  it('omits the analysis, urgency and rating when the item has none', () => {
    renderOverlay({
      ...ITEM, urgency: 'low', rating: undefined, problem_summary: undefined, problem_root_cause_hypothesis: undefined,
    })
    expect(screen.queryByText('Issue:')).not.toBeInTheDocument()
    expect(screen.queryByText('Urgent')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/\/ 5$/)).not.toBeInTheDocument()
  })

  it('links to the source in a new tab only when there is one', () => {
    renderOverlay(ITEM)
    const source = screen.getByRole('link', { name: /view source/i })
    expect(source).toHaveAttribute('href', 'https://reviews.example.com/42')
    expect(source).toHaveAttribute('target', '_blank')
    expect(source).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('has no source link for an item without a URL', () => {
    renderOverlay({ ...ITEM, source_url: undefined })
    expect(screen.queryByRole('link', { name: /view source/i })).not.toBeInTheDocument()
  })

  it('links to the full detail page', () => {
    renderOverlay(ITEM)
    expect(screen.getByRole('link', { name: 'Open full details' })).toHaveAttribute('href', '/feedback/fb-42')
  })

  it('closes from the close button and from Escape', async () => {
    const user = userEvent.setup()
    const onClose = renderOverlay(ITEM)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
