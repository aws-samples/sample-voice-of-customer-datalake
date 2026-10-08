/**
 * "By dimension" card: hidden without dimensions; shows values largest first
 * with their sentiment split in text, the unassigned count, and re-reads when
 * another dimension is picked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import DimensionBreakdown from './DimensionBreakdown'

const productMetrics = {
  key: 'product', period_days: 7, is_partial: false, unassigned: 3,
  values: {
    web_shop: { count: 2, positive: 0, negative: 2, neutral: 0, mixed: 0 },
    mobile_app: { count: 5, positive: 4, negative: 1, neutral: 0, mixed: 0 },
  },
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({
    'GET /settings/dimensions': () => dimensionsWire,
    'GET /metrics/dimensions?days=7&key=product': () => productMetrics,
    'GET /metrics/dimensions?days=7&key=user_type': () => ({ ...productMetrics, key: 'user_type', values: {}, unassigned: 0 }),
  })
})

describe('DimensionBreakdown', () => {
  it('lists values largest first with their sentiment split and the unassigned count', async () => {
    renderWithQueryClient(<DimensionBreakdown dateParams={{ days: 7 }} />)
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => within(row).getAllByText(/./)[0]?.textContent)).toStrictEqual(['Mobile app', 'Web shop'])
    expect(within(rows[0] ?? document.body).getByText('4 positive · 0 neutral · 0 mixed · 1 negative')).toBeInTheDocument()
    expect(screen.getByText('3 reviews without a value')).toBeInTheDocument()
  })

  it('reads another dimension when it is picked', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionBreakdown dateParams={{ days: 7 }} />)
    await user.selectOptions(await screen.findByLabelText('Dimension'), 'user_type')
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/metrics/dimensions?days=7&key=user_type', undefined))
    expect(await screen.findByText('No reviews in this window.')).toBeInTheDocument()
  })

  it('renders nothing when no dimensions are configured', async () => {
    routeFetchApi({ 'GET /settings/dimensions': () => ({ dimensions: [] }) })
    const { container } = renderWithQueryClient(<DimensionBreakdown dateParams={{ days: 7 }} />)
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/dimensions', undefined))
    expect(container).toBeEmptyDOMElement()
  })
})
