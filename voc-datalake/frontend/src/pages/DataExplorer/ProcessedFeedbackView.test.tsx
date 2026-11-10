/**
 * Processed records read like the rest of the app: the category is its
 * configured name (or the humanised id), never the raw id ("software_firmware").
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { feedbackItem } from '../Categories/categories-fixtures'
import ProcessedFeedbackView from './ProcessedFeedbackView'

vi.mock('../../hooks/useCategories', () => ({
  useCategoriesConfig: () => ({
    data: { categories: [{ id: 'c1', name: 'pricing_licensing', description: 'Pricing & Licensing', subcategories: [] }] },
  }),
}))
vi.mock('../../hooks/useDimensions', () => ({ useSourceProfiles: () => ({ data: [] }) }))

function renderRecord(category: string) {
  const item = feedbackItem({ feedback_id: 'f1', category })
  render(<ProcessedFeedbackView data={{ items: [item], total: 1, isLowerBound: false }} loading={false} onView={vi.fn()} onEdit={vi.fn()} />)
}

describe('ProcessedFeedbackView category label', () => {
  it('shows a configured category by its configured name, keeping the id as the title', () => {
    renderRecord('pricing_licensing')
    expect(screen.getByText('Category: Pricing & Licensing')).toHaveAttribute('title', 'pricing_licensing')
  })

  it('humanises a category id with no configured name', () => {
    renderRecord('software_firmware')
    expect(screen.getByText('Category: Software firmware')).toBeInTheDocument()
  })
})

describe('ProcessedFeedbackView paging and details', () => {
  const one = feedbackItem({ feedback_id: 'f1', category: 'software_firmware', original_text: 'Boots slowly', title: 'Slow boot' })

  it('says "1 shown, more available" for a lower-bound count and loads more on request', async () => {
    const load = vi.fn()
    render(<ProcessedFeedbackView data={{ items: [one], total: 200, isLowerBound: true }} loading={false}
      onView={vi.fn()} onEdit={vi.fn()} more={{ hasMore: true, loading: false, load }} />)

    expect(screen.getByText('1 shown, more available')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  // Wave 4: "95 of 95 or more" when the lower bound equals what is shown and nothing more loads.
  it('says just "1 shown" when the lower bound is all there is', () => {
    render(<ProcessedFeedbackView data={{ items: [one], total: 1, isLowerBound: true }} loading={false}
      onView={vi.fn()} onEdit={vi.fn()} more={{ hasMore: false, loading: false, load: vi.fn() }} />)
    expect(screen.getByText('1 shown')).toBeInTheDocument()
    expect(screen.queryByText(/or more/)).not.toBeInTheDocument()
  })

  it('offers no Load more when everything is loaded', () => {
    render(<ProcessedFeedbackView data={{ items: [one], total: 1, isLowerBound: false }} loading={false}
      onView={vi.fn()} onEdit={vi.fn()} more={{ hasMore: false, loading: false, load: vi.fn() }} />)

    expect(screen.getByText('Showing 1 of 1 records')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('shows readable details, with the stored JSON behind "Show raw JSON"', async () => {
    const user = userEvent.setup()
    render(<ProcessedFeedbackView data={{ items: [one], total: 1, isLowerBound: false }} loading={false} onView={vi.fn()} onEdit={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Slow boot')).toBeInTheDocument()
    expect(screen.queryByText(/"feedback_id"/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show raw JSON' }))
    expect(screen.getByText(/"feedback_id": "f1"/)).toBeInTheDocument()
  })
})

describe('ProcessedFeedbackView review text', () => {
  it('previews and details a review stored with markdown escapes as plain text', async () => {
    const stored = feedbackItem({ feedback_id: 'f2', original_text: 'Hard situation\\.On time **next** day', title: '**Fine**' })
    render(<ProcessedFeedbackView data={{ items: [stored], total: 1, isLowerBound: false }} loading={false} onView={vi.fn()} onEdit={vi.fn()} />)

    expect(screen.getByText('Hard situation. On time next day')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Fine')).toBeInTheDocument()
    expect(screen.getAllByText('Hard situation. On time next day')).toHaveLength(2)
  })
})
