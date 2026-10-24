/**
 * @fileoverview The review modal end to end against a router: `?review=` opens it on the current
 * page, Back / the close button / Escape close it, it stacks over a page dialog and the
 * full-screen assistant, and the Radar variant (`&reviewBrand=`) is read-only with its brand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { createTestQueryClient } from '../../test/query-client'
import { configStoreModule } from '../../pages/Categories/categories-fixtures'
import { ApiError } from '../../lib/errors'
import ModalShell from '../ModalShell/ModalShell'
import ReviewLink from '../ReviewLink/ReviewLink'
import ReviewModalHost from './ReviewModalHost'

const getFeedbackById = vi.fn<(id: string) => Promise<unknown>>()
const getSimilarFeedback = vi.fn<(id: string) => Promise<unknown>>()
const fetchApi = vi.fn<(endpoint: string) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackById: (id: string) => getFeedbackById(id),
    getSimilarFeedback: (id: string) => getSimilarFeedback(id),
  },
  fetchApi: (endpoint: string) => fetchApi(endpoint),
}))
vi.mock('../../store/configStore', () => configStoreModule())

const OUR_REVIEW = {
  feedback_id: 'fb-1', source_platform: 'webscraper', source_channel: 'reviews', original_text: 'Late again.',
  original_language: 'en', sentiment_label: 'negative', sentiment_score: -0.6, category: 'delivery',
  journey_stage: 'delivery', impact_area: 'logistics', urgency: 'high', source_created_at: '2026-01-01T10:00:00Z',
  processed_at: '2026-01-01T10:05:00Z',
}

const RADAR_ANSWER = {
  brand: { key: 'acme', label: 'Acme' },
  review: {
    feedback_id: 'acme-r01', day: '2026-10-01', text: 'Waited a week for support.', sentiment_label: 'negative',
    sentiment_score: -0.7, category: 'customer_support', subcategory: 'response_time', source_platform: 'competitor_reviews',
    persona_name: 'Busy Parent', journey_stage: 'support', impact_area: 'customer_support',
    problem_root_cause_hypothesis: 'Too few agents.', source_created_at: '2026-10-01T09:30:00Z', language: 'en',
  },
}

function Page({ withPageDialog = false }: Readonly<{ withPageDialog?: boolean }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const links = (
    <>
      <ReviewLink feedbackId="fb-1">Open ours</ReviewLink>
      <ReviewLink feedbackId="acme-r01" brand="acme">Open radar</ReviewLink>
    </>
  )
  return (
    <div>
      <p data-testid="location">{`${location.pathname}${location.search}`}</p>
      <button type="button" onClick={() => { void navigate(-1) }}>History back</button>
      {withPageDialog ? <ModalShell isOpen onClose={() => undefined} ariaLabel="Acme reviews">{links}</ModalShell> : links}
      {/* Stands in for the full-screen assistant, which Layout mounts before the host. */}
      <div data-testid="fullscreen-assistant" className="fixed inset-0 z-[60]" />
    </div>
  )
}

function renderAt(entry: string, options: { withPageDialog?: boolean } = {}) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="*" element={<><Page withPageDialog={options.withPageDialog} /><ReviewModalHost /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

const location = () => screen.getByTestId('location').textContent
const reviewDialog = () => screen.findByRole('dialog', { name: 'Review details' })

/** Press the dialog's close button and wait for the URL it should land on. */
async function closeAndExpect(user: ReturnType<typeof userEvent.setup>, expected: string) {
  await user.click(within(await reviewDialog()).getByRole('button', { name: 'Close review' }))
  await waitFor(() => { expect(location()).toBe(expected) })
}

beforeEach(() => {
  getFeedbackById.mockReset().mockResolvedValue(OUR_REVIEW)
  getSimilarFeedback.mockReset().mockResolvedValue({ items: [] })
  fetchApi.mockReset().mockResolvedValue(RADAR_ANSWER)
})

describe('ReviewModal — opening and closing through the URL', () => {
  it('opens on the current page with ?review= and Back closes it', async () => {
    const user = renderAt('/categories?category=delivery')
    await user.click(screen.getByRole('link', { name: 'Open ours' }))
    expect(location()).toBe('/categories?category=delivery&review=fb-1')
    expect(await within(await reviewDialog()).findByText('Late again.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History back' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Review details' })).not.toBeInTheDocument() })
  })

  it('the close button pops the entry it pushed, back to the page as it was', async () => {
    const user = renderAt('/problems')
    await user.click(screen.getByRole('link', { name: 'Open ours' }))
    expect(location()).toBe('/problems?review=fb-1')
    await closeAndExpect(user, '/problems')
  })

  it('a pasted link opens the modal, and closing it drops only the review params', async () => {
    const user = renderAt('/dashboard?tab=x&review=fb-1')
    expect(await reviewDialog()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => { expect(location()).toBe('/dashboard?tab=x') })
  })

  it('a similar item swaps ?review= in place and keeps the modal open', async () => {
    getSimilarFeedback.mockResolvedValue({ items: [{ ...OUR_REVIEW, feedback_id: 'fb-2', original_text: 'Also late.' }] })
    const user = renderAt('/problems')
    await user.click(screen.getByRole('link', { name: 'Open ours' }))
    const dialog = await reviewDialog()
    await user.click(await within(dialog).findByRole('button', { name: 'Show' }))
    await user.click(await within(dialog).findByRole('link', { name: /Also late\./ }))
    await waitFor(() => { expect(location()).toBe('/problems?review=fb-2') })
    expect(getFeedbackById).toHaveBeenLastCalledWith('fb-2')
    // One close leaves the modal however many reviews were walked through.
    await closeAndExpect(user, '/problems')
  })

  it('offers the full page for our review and shows the not-found state for a missing one', async () => {
    getFeedbackById.mockRejectedValue(new ApiError(404))
    renderAt('/?review=gone')
    const dialog = await reviewDialog()
    expect(within(dialog).getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/feedback/gone')
    expect(await within(dialog).findByText('Feedback not found')).toBeInTheDocument()
    expect(within(dialog).queryByRole('link', { name: 'Back to feedback list' })).not.toBeInTheDocument()
  })
})

describe('ReviewModal — stacking', () => {
  it('paints after the full-screen assistant at z-[70]', async () => {
    renderAt('/chat?review=fb-1')
    const wrapper = (await reviewDialog()).parentElement
    expect(wrapper).toHaveClass('z-[70]')
    const order = screen.getByTestId('fullscreen-assistant').compareDocumentPosition(wrapper ?? document.body)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('opens over a page dialog (the Radar reviews list); Escape closes only the top-most', async () => {
    const user = renderAt('/radar', { withPageDialog: true })
    await user.click(within(screen.getByRole('dialog', { name: 'Acme reviews' })).getByRole('link', { name: 'Open radar' }))
    expect(await screen.findByRole('dialog', { name: 'Radar review details' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Radar review details' })).not.toBeInTheDocument() })
    expect(screen.getByRole('dialog', { name: 'Acme reviews' })).toBeInTheDocument()
  })
})

describe('ReviewModal — the Radar variant', () => {
  it('reads the single-review route and titles it "<brand> review" with the Radar badge', async () => {
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    expect(await within(dialog).findByText('Waited a week for support.')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/radar/brands/acme/reviews/acme-r01')
    expect(within(dialog).getByText('Radar review')).toBeInTheDocument()
    // Named by the brand's label, never by the stored source id ("Radar example air App review").
    expect(within(dialog).getByRole('heading', { name: 'Acme review' })).toBeInTheDocument()
  })

  it('shows the detail-only fields', async () => {
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    expect(await within(dialog).findByText('Busy Parent')).toBeInTheDocument()
    expect(within(dialog).getByText('Too few agents.')).toBeInTheDocument()
  })

  it('hides edits, similar items, tag chips and the full-page link', async () => {
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    await within(dialog).findByText('Waited a week for support.')
    expect(within(dialog).queryByText('Similar Feedback')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Tags & Filters')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('link', { name: 'Open full page' })).not.toBeInTheDocument()
  })

  it('shows the written day the list shows, with no second date when the source agrees', async () => {
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    expect(await within(dialog).findByText('Review date: Oct 1, 2026')).toBeInTheDocument()
    expect(within(dialog).queryByText(/^Source date:/)).not.toBeInTheDocument()
  })

  it('labels the source timestamp when it names another day than the list (prod 5.14: 10-18 vs Oct 16)', async () => {
    fetchApi.mockResolvedValue({ ...RADAR_ANSWER, review: { ...RADAR_ANSWER.review, day: '2026-10-16', source_created_at: '2026-10-18T09:30:00Z' } })
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    expect(await within(dialog).findByText('Review date: Oct 16, 2026')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Source date: Oct 18, 2026/)).toBeInTheDocument()
  })

  it('answers a 404 with the not-found state', async () => {
    fetchApi.mockRejectedValueOnce(new ApiError(404))
    renderAt('/radar?review=nope&reviewBrand=acme')
    expect(await screen.findByText('Feedback not found')).toBeInTheDocument()
  })

  it('offers a retry when the read fails for another reason', async () => {
    fetchApi.mockRejectedValue(new ApiError(500))
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    expect(await screen.findByText('Couldn’t load this review.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // verify4 V5: the modal showed "Rating:" with only star icons (no readable value) while the list said "Rated 1".
  it('shows the rating as a value, the same field the list reads', async () => {
    fetchApi.mockResolvedValue({ ...RADAR_ANSWER, review: { ...RADAR_ANSWER.review, rating: 1 } })
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    expect(await within(dialog).findByRole('img', { name: '1 out of 5 stars' })).toHaveTextContent('1/5')
  })

  it('hides the rating row when the review has no rating', async () => {
    renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    await within(dialog).findByText('Waited a week for support.')
    expect(within(dialog).queryByText('Rating:')).not.toBeInTheDocument()
  })

  it('offers Copy link, which copies the address that reopens this review', async () => {
    const user = renderAt('/radar?review=acme-r01&reviewBrand=acme')
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const dialog = await screen.findByRole('dialog', { name: 'Radar review details' })
    await user.click(await within(dialog).findByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/radar?review=acme-r01&reviewBrand=acme`)
  })
})
