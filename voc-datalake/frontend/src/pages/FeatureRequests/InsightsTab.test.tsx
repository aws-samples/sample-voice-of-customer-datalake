/**
 * `/feature-requests?tab=insights`: loading, an empty window, the figures (totals, the most-supported
 * requests linking to their detail, the three breakdowns), the board and window controls in the URL,
 * and the admin-only "Enrich requests".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { SearchProbe } from './search-probe-fixtures'
import { fixtureBoard } from './feature-board-fixtures'
import type { FeatureRequestInsights } from '../../api/featureRequestInsightsSchema'

const api = vi.hoisted(() => ({ getFeatureRequestInsights: vi.fn(), enrichFeatureRequests: vi.fn() }))
vi.mock('../../api/featureRequestInsights', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/featureRequestInsights')>(), ...api,
}))
vi.mock('../../hooks/useDisplayLabels', async () => {
  const { humanizeId } = await import('../../utils/displayLabels')
  return { useDisplayLabels: () => ({ category: humanizeId }) }
})
import InsightsTab from './InsightsTab'

const SALES = fixtureBoard('sales', { board_id: 'brd_sales', name: 'Sales feature requests' })
const OLD = fixtureBoard('beta', { board_id: 'brd_old', name: 'Old board', archived: true })

const EMPTY: FeatureRequestInsights = {
  board: null, window_days: 90, totals: { requests: 0, supporters: 0, enriched: 0 }, truncated: false,
  top: [], by_category: [], by_status: [], by_sentiment: [],
}
const FIGURES: FeatureRequestInsights = {
  ...EMPTY,
  totals: { requests: 3, supporters: 7, enriched: 2 },
  top: [{ request_id: 'fr_1', board_id: 'brd_sales', title: 'Single sign-on', status: 'new', supporters: 5, category: 'account_access' }],
  by_category: [{ category: 'account_access', requests: 2, supporters: 6 }, { category: null, requests: 1, supporters: 1 }],
  by_status: [{ status: 'under_review', requests: 3, supporters: 7 }],
  by_sentiment: [{ sentiment: 'negative', requests: 2 }, { sentiment: null, requests: 1 }],
}

function renderTab({ isAdmin = false, entry = '/feature-requests?tab=insights' } = {}) {
  renderWithQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <InsightsTab boards={[SALES, OLD]} isAdmin={isAdmin} />
      <SearchProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  api.getFeatureRequestInsights.mockReset().mockResolvedValue(FIGURES)
  api.enrichFeatureRequests.mockReset().mockResolvedValue({ queued: 2, remaining: 5 })
})

describe('the Insights tab', () => {
  it('says it is loading until the figures arrive', async () => {
    api.getFeatureRequestInsights.mockReturnValue(new Promise(() => {}))
    renderTab()
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
  })

  it('says so when the window has no requests', async () => {
    api.getFeatureRequestInsights.mockResolvedValue(EMPTY)
    renderTab()
    expect(await screen.findByTestId('fr-insights-empty')).toHaveTextContent('No requests in this window.')
  })

  it('shows the totals and the most-supported requests, each linking to its detail', async () => {
    renderTab()
    const totals = within(await screen.findByTestId('fr-insights-totals'))
    expect(totals.getByText('7')).toBeInTheDocument()
    const link = within(screen.getByTestId('fr-insights-top')).getByRole('link', { name: 'Single sign-on' })
    expect(link).toHaveAttribute('href', '/feature-requests?request=fr_1')
    expect(screen.getByTestId('fr-insights-top')).toHaveTextContent('Account access')
    expect(screen.queryByTestId('fr-insights-truncated')).not.toBeInTheDocument()
  })

  it('says when the server read only part of the window', async () => {
    api.getFeatureRequestInsights.mockResolvedValue({ ...FIGURES, truncated: true })
    renderTab()
    expect(await screen.findByTestId('fr-insights-truncated')).toHaveTextContent('These figures cover part of the window')
  })

  it('lists the breakdowns in words: no category, the board status label, not enriched', async () => {
    renderTab()
    expect(await screen.findByTestId('fr-insights-by-category')).toHaveTextContent('Uncategorized: 1 request')
    expect(screen.getByTestId('fr-insights-by-status')).toHaveTextContent('Under review: 3 requests')
    expect(screen.getByTestId('fr-insights-by-sentiment')).toHaveTextContent('Not enriched yet: 1 request')
  })

  it('reads every board for 90 days by default, and never offers an archived board', async () => {
    renderTab()
    await screen.findByTestId('fr-insights-totals')
    expect(api.getFeatureRequestInsights).toHaveBeenCalledWith({ board: undefined, days: 90 })
    expect(screen.queryByRole('option', { name: 'Old board' })).not.toBeInTheDocument()
  })

  it('keeps the board and window in the URL', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.selectOptions(await screen.findByLabelText('Board'), 'brd_sales')
    await user.selectOptions(screen.getByLabelText('Created in'), 'All time')
    await waitFor(() => expect(api.getFeatureRequestInsights).toHaveBeenLastCalledWith({ board: 'brd_sales', days: 0 }))
    expect(screen.getByTestId('search')).toHaveTextContent('board=brd_sales&days=0')
  })

  it('reads an archived board or an unknown window in the URL as every board and 90 days', async () => {
    renderTab({ entry: '/feature-requests?tab=insights&board=brd_old&days=7' })
    await screen.findByTestId('fr-insights-totals')
    expect(api.getFeatureRequestInsights).toHaveBeenCalledWith({ board: undefined, days: 90 })
  })
})

describe('Enrich requests', () => {
  it('is not offered to a non-admin', async () => {
    renderTab()
    await screen.findByTestId('fr-insights-totals')
    expect(screen.queryByRole('button', { name: 'Enrich requests' })).not.toBeInTheDocument()
  })

  it('queues the selected board for an admin and says how many', async () => {
    const user = userEvent.setup()
    renderTab({ isAdmin: true, entry: '/feature-requests?tab=insights&board=brd_sales' })
    await user.click(await screen.findByRole('button', { name: 'Enrich requests' }))
    expect(await screen.findByText('2 requests queued, 5 still to enrich.')).toBeInTheDocument()
    expect(api.enrichFeatureRequests).toHaveBeenCalledWith('brd_sales')
  })

  it('says so when the enrichment could not start', async () => {
    api.enrichFeatureRequests.mockRejectedValue(new Error('API Error: 500'))
    const user = userEvent.setup()
    renderTab({ isAdmin: true })
    await user.click(await screen.findByRole('button', { name: 'Enrich requests' }))
    expect(await screen.findByText('Could not start the enrichment. Try again.')).toBeInTheDocument()
  })
})
