import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { createTestQueryClient } from '../../../test/query-client'
import { corpusReview } from '../../../test/corpusReviewFixture'
import { configStoreModule } from '../../../pages/Categories/categories-fixtures'
import { ApiError } from '../../../lib/errors'
import EvidenceCards from './EvidenceCards'

const getFeedbackById = vi.fn<(id: string) => Promise<unknown>>()

vi.mock('../../../api/client', () => ({
  api: { getFeedbackById: (id: string) => getFeedbackById(id) },
  fetchApi: vi.fn(() => Promise.resolve({})),
}))
vi.mock('../../../store/configStore', () => configStoreModule())

function renderCards(props: Partial<React.ComponentProps<typeof EvidenceCards>> = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <EvidenceCards feedbackIds={undefined} featureRequestIds={[]} erasedEvidence={undefined} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getFeedbackById.mockReset()
  getFeedbackById.mockImplementation((id) => {
    if (id === 'gone') return Promise.reject(new ApiError(404))
    if (id === 'broken') return Promise.reject(new ApiError(500))
    return Promise.resolve(corpusReview(id, { rating: 2 }))
  })
})

const cardList = () => screen.getByRole('list', { name: 'Reviews it was written from' })

describe('EvidenceCards', () => {
  it('names the section and counts the reviews', () => {
    renderCards({ feedbackIds: ['r1', 'r2'] })
    expect(screen.getByRole('heading', { name: 'Evidence' })).toBeInTheDocument()
    expect(screen.getByText('Written from 2 reviews')).toBeInTheDocument()
    expect(within(cardList()).getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows each review as a compact card linking to the review, with its rating', async () => {
    renderCards({ feedbackIds: ['r1', 'r2'] })
    const link = await screen.findByRole('link', { name: /Review text r1/ })
    expect(link.getAttribute('href')).toContain('review=r1')
    expect(within(link).getByRole('img', { name: /2 out of 5/ })).toBeInTheDocument()
  })

  it('says a review is loading, unavailable or failed, with a retry for the failure', async () => {
    getFeedbackById.mockImplementationOnce(() => new Promise(() => {}))
    renderCards({ feedbackIds: ['slow', 'gone', 'broken'] })
    expect(await screen.findByText('This review is no longer available')).toBeInTheDocument()
    // A server error is retried once (retryOnceUnlessNotFound) before it shows.
    expect(await screen.findByText('Could not load this review', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading review')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows the first five and opens every review in the corpus dialog from "Show all"', async () => {
    const user = userEvent.setup()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    renderCards({ feedbackIds: ids })
    expect(within(cardList()).getAllByRole('listitem')).toHaveLength(5)
    expect(getFeedbackById).not.toHaveBeenCalledWith('f')
    await user.click(screen.getByRole('button', { name: 'Show all (7)' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Reviews it was written from' })).toBeInTheDocument()
    expect(await within(dialog).findByText(/Review text g/)).toBeInTheDocument()
  })

  it('offers no "Show all" when every review is already a card', () => {
    renderCards({ feedbackIds: ['a', 'b'] })
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('says so when the document recorded no evidence', () => {
    renderCards()
    expect(screen.getByText('No reviews or feature requests were recorded for this document.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('lists the feature requests it read as links to the board', () => {
    renderCards({ featureRequestIds: ['fr_1'] })
    expect(screen.queryByText(/No reviews or feature requests/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request fr_1' })).toHaveAttribute('href', '/feature-requests?request=fr_1')
  })

  it('keeps the erased-evidence count', () => {
    renderCards({ feedbackIds: ['a'], erasedEvidence: { count: 2 } })
    expect(screen.getByTestId('erased-evidence')).toHaveTextContent('2 cited reviews or board requests were erased')
  })

  it('drops its own heading inside a tab panel, which the tab names', () => {
    renderCards({ titled: false })
    expect(screen.queryByRole('heading', { name: 'Evidence' })).not.toBeInTheDocument()
  })
})
