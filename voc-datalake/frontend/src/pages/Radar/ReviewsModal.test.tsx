/**
 * Radar reviews modal: every opener (theme count, category count, quote, the sentiment tile, trend
 * day, compare cell) opens "<brand> reviews" with its filter; chips clear and refetch; "Load more"
 * follows the cursor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import Radar from './Radar'

const REVIEWS_PATH = '/radar/brands/rival/reviews'
/** The summary tile that opens every review of the window. */
const ALL_REVIEWS = /Their sentiment against yours/
const reviewItem = (id: string, text: string) => ({
  feedback_id: id, day: '2026-10-02', text, sentiment_label: 'positive', sentiment_score: 0.7,
  category: 'shipping', subcategory: 'tracking', source_platform: 'rival_src', source_url: 'https://reviews.example/r',
})

function routes(reviews: () => unknown): void {
  routeFetchApi({
    'GET /radar': () => ({ brands: [{ key: 'rival', label: 'Rival Co', total: 12 }] }),
    'GET /radar/brands/rival/page': () => ({
      detail: {
        brand: { key: 'rival', label: 'Rival Co' }, total: 12, avg_sentiment: 0.3,
        trend: [{ date: '2026-10-02', count: 12, avg_sentiment: 0.3 }],
        love: [{ category: 'shipping', subcategory: 'tracking', count: 4, quotes: ['Tracking is spot on'] }],
        hate: [{ category: 'returns', subcategory: null, count: 1, quotes: [] }],
      },
      releases: { releases: [] },
      compare: { ours_available: true, categories: [
        { category: 'returns', theirs: { volume: 3, positive_share: 0.2, negative_share: 0.7 }, ours: null, verdict: null },
      ] },
    }),
    [`GET ${REVIEWS_PATH}`]: reviews,
  }, { ignoreQuery: true })
}

const lastReviewsCall = (): string =>
  fetchApi.mock.calls.map(([endpoint]) => endpoint).filter((endpoint) => endpoint.startsWith(REVIEWS_PATH)).at(-1) ?? ''

async function openFrom(name: RegExp | string) {
  renderWithQueryClient(<MemoryRouter><Radar /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name }))
  return { user, dialog: await screen.findByRole('dialog', { name: 'Rival Co reviews' }) }
}

beforeEach(() => {
  resetFetchApi()
  routes(() => ({ reviews: [reviewItem('a', 'Tracking is spot on')], next_cursor: null }))
})

describe('Radar reviews modal', () => {
  it('a theme row keeps its count on one line and WRAPS its name (never cut at 390px)', async () => {
    renderWithQueryClient(<MemoryRouter><Radar /></MemoryRouter>)
    const count = await screen.findByRole('button', { name: 'Read the 4 reviews of Shipping / Tracking' })
    expect(count).toHaveTextContent('4 reviews')
    expect(count).toHaveClass('shrink-0')
    const name = within(count.closest('li') ?? document.body).getByText('Tracking')
    expect(name).toHaveClass('break-words', 'min-w-0')
    expect(name).not.toHaveClass('truncate')
  })

  it('opens from a love theme filtered to its category, subcategory and sentiment', async () => {
    const { dialog } = await openFrom('Read the 4 reviews of Shipping / Tracking')
    expect(await within(dialog).findByText('Tracking is spot on')).toBeInTheDocument()
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&category=shipping&subcategory=tracking&sentiment=positive`)
    expect(within(dialog).getByText('Category: Shipping')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /reviews\.example/ })).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('opens a whole category of a column from its heading count', async () => {
    await openFrom('Read all 4 reviews in Shipping')
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&category=shipping&sentiment=positive`)
  })

  it('asks for the reviews without a subcategory for a theme that has none', async () => {
    await openFrom('Read the review of Returns')
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&category=returns&subcategory=&sentiment=negative`)
  })

  it('labels the no-subcategory filter "No subcategory", never "Subcategory: none"', async () => {
    await openFrom('Read the review of Returns')
    expect(screen.getByRole('button', { name: 'Clear No subcategory' })).toBeInTheDocument()
    expect(screen.queryByText(/Subcategory: none/)).not.toBeInTheDocument()
  })

  it('opens the same theme from one of its quotes, and every review from the sentiment tile', async () => {
    const { user } = await openFrom(/Tracking is spot on/)
    expect(lastReviewsCall()).toContain('subcategory=tracking&sentiment=positive')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: ALL_REVIEWS }))
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90`)
  })

  it('clearing a chip refetches without it (the category takes its subcategory along)', async () => {
    const { user, dialog } = await openFrom('Read the 4 reviews of Shipping / Tracking')
    await user.click(within(dialog).getByRole('button', { name: 'Clear Category: Shipping' }))
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&sentiment=positive`)
    expect(within(dialog).queryByText(/Subcategory:/)).not.toBeInTheDocument()
  })

  it('narrows by sentiment from the select', async () => {
    const { user, dialog } = await openFrom(ALL_REVIEWS)
    await user.selectOptions(within(dialog).getByLabelText('Sentiment'), 'mixed')
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&sentiment=mixed`)
    expect(within(dialog).getByText('Sentiment: Mixed')).toBeInTheDocument()
  })

  it("opens a trend day's reviews from the keyboard-reachable day list", async () => {
    renderWithQueryClient(<MemoryRouter><Radar /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByText("Read a day's reviews"))
    await user.click(screen.getByRole('button', { name: 'Oct 2, 2026: 12 reviews' }))
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&day=2026-10-02`)
  })

  it("opens their reviews in a category from the comparison's Them cell", async () => {
    const { dialog } = await openFrom('Read their 3 reviews in Returns')
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&category=returns`)
    expect(within(dialog).getByText('Category: Returns')).toBeInTheDocument()
  })

  it('appends the next page on Load more, sending the cursor', async () => {
    const pages = [
      { reviews: [reviewItem('a', 'First page review')], next_cursor: 'CUR1' },
      { reviews: [reviewItem('b', 'Second page review')], next_cursor: null },
    ]
    routes(() => pages.shift())
    const { user, dialog } = await openFrom(ALL_REVIEWS)
    await user.click(await within(dialog).findByRole('button', { name: 'Load more' }))
    expect(await within(dialog).findByText('Second page review')).toBeInTheDocument()
    expect(within(dialog).getByText('First page review')).toBeInTheDocument()
    expect(lastReviewsCall()).toBe(`${REVIEWS_PATH}?days=90&cursor=CUR1`)
  })

  it('each review has a Details link opening the Radar review modal over the list', async () => {
    const { dialog } = await openFrom(ALL_REVIEWS)
    const details = await within(dialog).findByRole('link', { name: 'Details' })
    expect(details).toHaveAttribute('href', '/?review=a&reviewBrand=rival')
  })

  it('says so when the reviews cannot be loaded', async () => {
    routes(() => { throw new Error('API Error: 500') })
    const { dialog } = await openFrom(ALL_REVIEWS)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The reviews could not be loaded.')
  })

  it('shows the empty state when no review matches', async () => {
    routes(() => ({ reviews: [], next_cursor: null }))
    const { dialog } = await openFrom(ALL_REVIEWS)
    expect(await within(dialog).findByText('No review matches these filters.')).toBeInTheDocument()
  })

  it('clamps a long review behind Show more', async () => {
    routes(() => ({ reviews: [reviewItem('long', 'word '.repeat(120))], next_cursor: null }))
    const { user, dialog } = await openFrom(ALL_REVIEWS)
    const more = await within(dialog).findByRole('button', { name: 'Show more' })
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(more).toHaveTextContent('Show less')
  })
})
