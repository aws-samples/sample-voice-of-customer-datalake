/**
 * The /chat filter panel: collapsed by default and keyboard operable, a live review count from
 * `GET /metrics/sentiment`, a non-blocking warning over the 1,000-review cap, and the scope it
 * writes to the conversation (sent as `forwardedProps.scope`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { useChatScopeStore } from '../../assistant/store/chatScopeStore'
import { useConfigStore } from '../../store/configStore'
import type { SentimentBreakdown } from '../../api/types'
import ChatScopePanel from './ChatScopePanel'

const { getSentiment, getEntities } = vi.hoisted(() => ({ getSentiment: vi.fn(), getEntities: vi.fn() }))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, api: { ...actual.api, getSentiment, getEntities } }
})
vi.mock('../../components/TimeRangeSelector/TimeRangeSelector', () => ({ default: () => <div>time range picker</div> }))
vi.mock('../../hooks/useDisplayLabels', () => {
  const same = (id: string) => id
  return { useDisplayLabels: () => ({ category: same, subcategory: same, theme: same, source: same, keyword: same, plain: same }) }
})

const THREAD = 'thread-1'

function breakdown(counts: Record<string, number>, isPartial = false): SentimentBreakdown {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  return { period_days: 7, total, is_partial: isPartial, breakdown: counts, percentages: {} }
}

const BY_CATEGORY: Record<string, SentimentBreakdown> = {
  delivery: breakdown({ positive: 100, negative: 200 }),
  billing: breakdown({ positive: 10, negative: 40 }),
}

beforeEach(() => {
  getSentiment.mockReset()
  getSentiment.mockImplementation((_range: unknown, _source?: string, _filters?: unknown, category?: string) =>
    Promise.resolve(category === undefined ? breakdown({ positive: 900, negative: 347 }) : BY_CATEGORY[category]))
  getEntities.mockResolvedValue({
    period_days: 7, feedback_count: 1247,
    entities: { keywords: {}, issues: {}, personas: {}, categories: { delivery: 300, billing: 50 }, sources: { webscraper: 1000, manual_import: 247 } },
    channels: { email: 3 }, tags: { VIP: 2 },
  })
  useChatScopeStore.setState({ byThread: {} })
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com' } }))
})

function header(): HTMLElement {
  return screen.getByRole('button', { name: /Feedback scope/ })
}

describe('ChatScopePanel', () => {
  it('starts collapsed with the whole window counted and the over-cap warning', async () => {
    render(<ChatScopePanel threadId={THREAD} />)
    expect(header()).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByText('1,247 reviews')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('more than 1,000 reviews')
  })

  it('opens from the keyboard and narrows the scope with a source', async () => {
    const user = userEvent.setup()
    render(<ChatScopePanel threadId={THREAD} />)
    header().focus()
    await user.keyboard('{Enter}')
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    await user.selectOptions(await screen.findByLabelText('Source'), 'webscraper')
    expect(useChatScopeStore.getState().byThread[THREAD]).toStrictEqual({ source: 'webscraper' })
    await waitFor(() => expect(getSentiment).toHaveBeenLastCalledWith(expect.anything(), 'webscraper', {}, undefined))
  })

  it('counts several categories as one call each, summed, and a sentiment as its bucket', async () => {
    useChatScopeStore.setState({ byThread: { [THREAD]: { category: 'delivery,billing', sentiment: 'negative' } } })
    render(<ChatScopePanel threadId={THREAD} />)
    expect(await screen.findByText('240 reviews')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('2 filters')).toBeInTheDocument()
  })

  it('maps rating and urgent to the routes\u2019 item filters and shows a partial count as a lower bound', async () => {
    getSentiment.mockResolvedValue(breakdown({ negative: 12 }, true))
    useChatScopeStore.setState({ byThread: { [THREAD]: { rating: '2', rating_dir: 'below', urgent: '1' } } })
    render(<ChatScopePanel threadId={THREAD} />)
    expect(await screen.findByText('12+ reviews')).toBeInTheDocument()
    expect(getSentiment).toHaveBeenCalledWith(expect.anything(), undefined, { rating_max: 2, urgent: 1 }, undefined)
  })

  it('checks categories and clears every filter', async () => {
    const user = userEvent.setup()
    render(<ChatScopePanel threadId={THREAD} />)
    await user.click(header())
    await user.click(await screen.findByRole('checkbox', { name: 'delivery' }))
    await user.click(screen.getByRole('checkbox', { name: 'Urgent only' }))
    expect(useChatScopeStore.getState().byThread[THREAD]).toStrictEqual({ category: 'delivery', urgent: '1' })
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(useChatScopeStore.getState().byThread[THREAD]).toStrictEqual({})
  })
})
