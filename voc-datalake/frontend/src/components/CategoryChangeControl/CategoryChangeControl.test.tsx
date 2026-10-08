/**
 * "Change category": offers only visible categories, PUTs the change, refreshes
 * feedback + metrics, and explains refusals; the manual badge names who changed it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { primeCategoryClient } from '@test/categoryClientMock'

const client = await vi.hoisted(async () =>
  (await import('@test/categoryClientMock')).createCategoryClientMock())
vi.mock('../../api/client', () => client.module)

import CategoryChangeControl, { ManualCategoryBadge } from './CategoryChangeControl'
import type { FeedbackItem } from '../../api/types'

const feedback: FeedbackItem = {
  feedback_id: 'fb_1', source_id: 's', source_platform: 'webscraper', source_channel: 'review', brand_name: 'b',
  source_created_at: '', processed_at: '', original_text: 'Late again', original_language: 'en',
  category: 'delivery', subcategory: 'late_delivery', journey_stage: '', sentiment_label: 'negative',
  sentiment_score: -0.5, urgency: 'high', impact_area: '',
}

const CONFIG = {
  categories: [
    { id: 'cat_delivery', name: 'delivery', description: 'Delivery', subcategories: [{ id: 'sub_late', name: 'late_delivery', description: 'Late' }] },
    { id: 'cat_pricing', name: 'pricing', description: 'Pricing', subcategories: [] },
    { id: 'cat_secret', name: 'secret', description: 'Secret', subcategories: [] },
  ],
}

function renderControl(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return { queryClient, ...render(<QueryClientProvider client={queryClient}><CategoryChangeControl feedback={feedback} /></QueryClientProvider>) }
}

beforeEach(() => {
  primeCategoryClient(client, CONFIG)
  client.fetchApi.mockImplementation((endpoint: string) => Promise.resolve(
    endpoint === '/feedback/access'
      ? { all: false, categories: ['delivery', 'pricing'] }
      : { success: true, feedback: { feedback_id: 'fb_1', category: 'pricing', category_source: 'manual' } },
  ))
})

describe('CategoryChangeControl', () => {
  it('offers only the categories the caller can see, preselecting the current one', async () => {
    const user = userEvent.setup()
    renderControl()
    await user.click(screen.getByRole('button', { name: 'Change category' }))
    const select = await screen.findByLabelText('Category')
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Secret' })).not.toBeInTheDocument())
    expect(screen.getByRole('option', { name: 'Pricing' })).toBeInTheDocument()
    expect(select).toHaveValue('delivery')
  })

  it('saves the new category and refreshes feedback and metrics', async () => {
    const user = userEvent.setup()
    const { queryClient } = renderControl()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await user.click(screen.getByRole('button', { name: 'Change category' }))
    await user.selectOptions(await screen.findByLabelText('Category'), 'pricing')
    await user.click(screen.getByRole('button', { name: 'Save category' }))
    await waitFor(() => expect(client.fetchApi).toHaveBeenCalledWith('/feedback/fb_1/category', { method: 'PUT', body: JSON.stringify({ category: 'pricing' }) }))
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys).toStrictEqual(expect.arrayContaining(['["feedback"]', '["summary"]', '["categories"]']))
  })

  it('keeps Save disabled until something changes', async () => {
    const user = userEvent.setup()
    renderControl()
    await user.click(screen.getByRole('button', { name: 'Change category' }))
    await screen.findByLabelText('Category')
    expect(screen.getByRole('button', { name: 'Save category' })).toBeDisabled()
  })

  it('explains a concurrent change (409)', async () => {
    const user = userEvent.setup()
    renderControl()
    await user.click(screen.getByRole('button', { name: 'Change category' }))
    await user.selectOptions(await screen.findByLabelText('Category'), 'pricing')
    client.fetchApi.mockRejectedValueOnce(new Error('API Error: 409'))
    await user.click(screen.getByRole('button', { name: 'Save category' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed this review at the same time/i)
  })
})

describe('ManualCategoryBadge', () => {
  it('names who changed the category and what it was', () => {
    render(<ManualCategoryBadge feedback={{ category_source: 'manual', category_override: { previous_category: 'delivery', by_username: 'ada', at: '2026-02-03T10:00:00Z' } }} />)
    const badge = screen.getByText('Changed by ada')
    expect(badge).toHaveAttribute('title', expect.stringContaining('Was delivery'))
  })

  it('renders nothing for a model-assigned category', () => {
    const { container } = render(<ManualCategoryBadge feedback={{ category_source: 'reprocess' }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
