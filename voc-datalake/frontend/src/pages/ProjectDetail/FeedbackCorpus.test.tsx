/**
 * @fileoverview The corpus behind a persona or document (#236): the count of `input_feedback_ids`,
 * and the list of those reviews opened one id at a time, ten per page, with an erased or hidden
 * review shown as unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { createTestQueryClient } from '../../test/query-client'
import { configStoreModule } from '../Categories/categories-fixtures'
import { ApiError } from '../../lib/errors'
import FeedbackCorpus from './FeedbackCorpus'
import { corpusIds } from './feedbackCorpusIds'

const getFeedbackById = vi.fn<(id: string) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: { getFeedbackById: (id: string) => getFeedbackById(id) },
  fetchApi: vi.fn(() => Promise.resolve({})),
}))
vi.mock('../../store/configStore', () => configStoreModule())

function review(id: string) {
  return {
    feedback_id: id, source_platform: 'webscraper', original_text: `Review text ${id}`, sentiment_label: 'negative',
    sentiment_score: -0.5, category: 'delivery', urgency: 'low', source_created_at: '2026-01-01T10:00:00Z',
    processed_at: '2026-01-01T10:05:00Z',
  }
}

function renderCorpus(ids: readonly string[] | undefined) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <FeedbackCorpus feedbackIds={ids} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openList() {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show reviews' }))
  return screen.getByRole('dialog')
}

beforeEach(() => {
  getFeedbackById.mockReset()
  getFeedbackById.mockImplementation((id) => (
    id === 'gone' ? Promise.reject(new ApiError(404)) : Promise.resolve(review(id))
  ))
})

describe('FeedbackCorpus', () => {
  it('renders nothing for an artefact generated before the corpus was stored', () => {
    const { container } = renderCorpus(undefined)
    expect(container).toBeEmptyDOMElement()
    renderCorpus([])
    expect(screen.queryByTestId('feedback-corpus')).toBeNull()
  })

  it('shows how many reviews the generation read', () => {
    renderCorpus(['a', 'b', 'c'])
    expect(screen.getByTestId('feedback-corpus')).toHaveTextContent('Written from 3 reviews')
  })

  it('opens the reviews by id and shows an erased one as unavailable', async () => {
    renderCorpus(['a', 'gone'])
    const dialog = await openList()
    expect(await within(dialog).findByText('Review text a')).toBeInTheDocument()
    expect(await within(dialog).findByText('This review is no longer available')).toBeInTheDocument()
    expect(getFeedbackById.mock.calls.map(([id]) => id)).toStrictEqual(['a', 'gone'])
  })

  it('reads only the first ten reviews when it opens', async () => {
    renderCorpus(Array.from({ length: 23 }, (_, n) => `f${n}`))
    const dialog = await openList()
    expect(await within(dialog).findByText('Review text f9')).toBeInTheDocument()
    expect(getFeedbackById).toHaveBeenCalledTimes(10)
    expect(within(dialog).getByText('1–10 of 23')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Previous' })).toBeDisabled()
  })

  it('pages through the rest ten at a time', async () => {
    renderCorpus(Array.from({ length: 23 }, (_, n) => `f${n}`))
    const dialog = await openList()
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    expect(await within(dialog).findByText('Review text f22')).toBeInTheDocument()
    expect(within(dialog).getByText('21–23 of 23')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(getFeedbackById).toHaveBeenCalledTimes(23)
  })

  it('offers a retry when a review fails to load for another reason', async () => {
    getFeedbackById.mockImplementation(() => Promise.reject(new ApiError(500)))
    renderCorpus(['a'])
    const dialog = await openList()
    expect(await within(dialog).findByText('Could not load this review', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(within(dialog).queryByText('This review is no longer available')).toBeNull()
  })

  it('renders the list beside the line, not inside its paragraph', async () => {
    renderCorpus(['a'])
    const dialog = await openList()
    const line = screen.getByTestId('feedback-corpus')
    expect(line.tagName).toBe('P')
    expect(line.contains(dialog)).toBe(false)
  })

  it('closes from its close button', async () => {
    renderCorpus(['a'])
    const dialog = await openList()
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('corpusIds', () => {
  it('keeps the stored order, drops blanks and duplicates, and caps at the backend limit', () => {
    expect(corpusIds(['b', '', 'a', 'b'])).toStrictEqual(['b', 'a'])
    expect(corpusIds(Array.from({ length: 600 }, (_, n) => `f${n}`))).toHaveLength(500)
    expect(corpusIds(undefined)).toStrictEqual([])
  })
})
