/**
 * The platform console's cost page (Administration → Workspaces → Costs): an estimate said as such with its price
 * list's date, each workspace's tokens and estimated cost (incomplete and unpriced said in words, with the models not
 * priced), the deployment's own, the inactive workspaces' and the unattributed calls, month subtotals when the period
 * spans months, a period switch (last 30 days by default), Show more for the next page, a 403 and a failed read said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { defined } from '../../test/defined'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { CostDay, CostSum } from '../../api/platformCostsApi'
import PlatformCostsSection from './PlatformCostsSection'

const SUM: CostSum = {
  calls: 4, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0,
  estimated_usd: '0.750000', complete: true, unpriced_models: [],
}
const summary = (days: readonly CostDay[], total: Partial<CostSum> = {}) => ({
  days, total: { ...SUM, ...total, by_model: [] },
})
const ACME = {
  id: 'ws_acme', name: 'Acme Outfitters', slug: 'acme', status: 'active',
  ...summary([{ date: '2026-10-30', ...SUM, estimated_usd: '0.250000' }, { date: '2026-11-02', ...SUM, estimated_usd: '0.500000' }]),
}
const JUNIPER = {
  id: 'ws_juniper', name: 'Juniper Trail Co.', slug: 'juniper', status: 'active',
  ...summary([{ date: '2026-11-03', ...SUM, estimated_usd: '2.000000', complete: false, unpriced_models: ['model-beta'] }],
    { estimated_usd: '2.000000', complete: false, unpriced_models: ['model-beta'] }),
}
const BIRCH = {
  id: 'ws_birch', name: 'Birch Lane', slug: 'birch', status: 'active',
  ...summary([{ date: '2026-11-04', ...SUM, estimated_usd: null, complete: false, unpriced_models: ['model-gamma'] }],
    { estimated_usd: null, complete: false, unpriced_models: ['model-gamma'] }),
}
const PAGE = {
  estimate: true, label: 'Estimate from list prices, not a bill', currency: 'USD', price_as_of: '2026-11-16',
  price_source: 'https://prices.example.com/', from: '2026-10-28', to: '2026-11-26', workspaces: [ACME, JUNIPER],
  next_cursor: null,
  deployment: { ...summary([], { calls: 2, estimated_usd: '0.100000' }), deleted_workspaces: { ...SUM, calls: 5, estimated_usd: '0.300000' } },
  unattributed: summary([], { calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: '0.000000' }),
}
const LAST_30 = 'GET /platform/costs?from=2026-10-28&to=2026-11-26'

function renderSection(routes: Record<string, RouteHandler> = { [LAST_30]: () => PAGE }) {
  routeFetchApi(routes)
  return render(<QueryClientProvider client={createTestQueryClient()}><PlatformCostsSection /></QueryClientProvider>)
}

const row = (name: string) => defined(screen.getAllByRole('row').find((candidate) => candidate.textContent.includes(name)), name)

beforeEach(() => {
  resetFetchApi()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('PlatformCostsSection', () => {
  it('says it is an estimate from list prices, with the price list and its date', async () => {
    renderSection()
    expect(screen.getByText(/Estimate from list prices, not a bill/u)).toBeInTheDocument()
    expect(await screen.findByText(/List prices read on Nov 16, 2026/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /price list/u })).toHaveAttribute('href', 'https://prices.example.com/')
  })

  it('reads the last 30 days first, and lists each workspace with its tokens and estimated cost', async () => {
    renderSection()
    const table = await screen.findByRole('table', { name: 'Estimated cost from Oct 28, 2026 to Nov 26, 2026' })
    const [head] = within(table).getAllByRole('rowgroup')
    expect(within(defined(head, 'thead')).getAllByRole('columnheader').map((cell) => cell.textContent))
      .toStrictEqual(['Name', 'Calls', 'Input tokens', 'Output tokens', 'Estimated cost'])
    const acme = row('Acme Outfitters')
    expect(within(acme).getByText('1,200')).toBeInTheDocument()
    expect(within(acme).getByText('$0.7500')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('last30')
  })

  it('marks an incomplete total and names the models not priced', async () => {
    renderSection()
    await screen.findByText('Juniper Trail Co.')
    const juniper = row('Juniper Trail Co.')
    expect(within(juniper).getByText('Incomplete')).toBeInTheDocument()
    expect(within(juniper).getByText('Not priced: model-beta')).toBeInTheDocument()
    expect(within(row('Acme Outfitters')).queryByText('Incomplete')).not.toBeInTheDocument()
  })

  it('says unpriced, never $0, when nothing of a total is priced', async () => {
    renderSection({ [LAST_30]: () => ({ ...PAGE, workspaces: [BIRCH] }) })
    await screen.findByText('Birch Lane')
    const birch = row('Birch Lane')
    expect(within(birch).getByText('Unpriced')).toBeInTheDocument()
    expect(within(birch).getByText('Not priced: model-gamma')).toBeInTheDocument()
    expect(within(birch).queryByText(/\$/u)).not.toBeInTheDocument()
  })

  it("shows the deployment's own, the inactive workspaces' and the unattributed calls", async () => {
    renderSection()
    await screen.findByText('Acme Outfitters')
    expect(within(row("The deployment's own calls")).getByText('$0.1000')).toBeInTheDocument()
    expect(within(row('Workspaces no longer active')).getByText('$0.3000')).toBeInTheDocument()
    expect(within(row('Not attributed to a workspace')).getByText('$0.0000')).toBeInTheDocument()
  })

  it('tells a priced figure below the column precision from a known zero, in one precision for the column', async () => {
    renderSection({ [LAST_30]: () => ({ ...PAGE, workspaces: [
      { ...ACME, ...summary([], { estimated_usd: '0.000040' }) },
      { ...JUNIPER, ...summary([], { estimated_usd: '12.5' }) },
    ] }) })
    await screen.findByText('Acme Outfitters')
    expect(within(row('Acme Outfitters')).getByText('< $0.0001')).toBeInTheDocument()
    expect(within(row('Acme Outfitters')).queryByText('$0.0000')).not.toBeInTheDocument()
    expect(within(row('Juniper Trail Co.')).getByText('$12.5000')).toBeInTheDocument()
    expect(within(row('Not attributed to a workspace')).getByText('$0.0000')).toBeInTheDocument()
  })

  it('sums each month when the period spans months', async () => {
    renderSection()
    const acme = await screen.findByText('Acme Outfitters').then(() => row('Acme Outfitters'))
    expect(within(acme).getByText('October 2026: $0.2500')).toBeInTheDocument()
    expect(within(acme).getByText('November 2026: $0.5000')).toBeInTheDocument()
  })

  it('reads another period when one is chosen', async () => {
    renderSection({
      [LAST_30]: () => PAGE,
      'GET /platform/costs?from=2026-10-01&to=2026-10-31': () => ({ ...PAGE, from: '2026-10-01', to: '2026-10-31', workspaces: [BIRCH] }),
    })
    await screen.findByText('Acme Outfitters')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'lastMonth')
    expect(await screen.findByText('Birch Lane')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Estimated cost from Oct 1, 2026 to Oct 31, 2026' })).toBeInTheDocument()
  })

  it('shows more workspaces from the next page', async () => {
    renderSection({
      [LAST_30]: () => ({ ...PAGE, next_cursor: 'next-1' }),
      [`${LAST_30}&cursor=next-1`]: () => ({ ...PAGE, deployment: undefined, unattributed: undefined, workspaces: [BIRCH] }),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Show more workspaces' }))
    expect(await screen.findByText('Birch Lane')).toBeInTheDocument()
    expect(screen.getByText('Acme Outfitters')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more workspaces' })).not.toBeInTheDocument()
    expect(screen.getAllByText("The deployment's own calls")).toHaveLength(1)
  })

  it('says how many rows it could not read', async () => {
    renderSection({ [LAST_30]: () => ({ ...PAGE, workspaces: [ACME, { name: 'drifted' }] }) })
    expect(await screen.findByText("1 workspace's row could not be read and is not shown.")).toBeInTheDocument()
  })

  it('says platform admins only on a 403', async () => {
    renderSection({ [LAST_30]: () => { throw new ApiError(403, 'Platform admin access required') } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Only platform admins can do that.')
  })

  it('says a failed read in words, with Try again, never as no cost', async () => {
    const answers = [() => { throw new Error('API Error: 500') }, () => PAGE]
    renderSection({ [LAST_30]: () => defined(answers.shift(), 'an answer')() })
    expect(await screen.findByRole('alert')).toHaveTextContent('The costs could not be loaded.')
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Acme Outfitters')).toBeInTheDocument()
    expect(new Set(fetchApi.mock.calls.map(([endpoint]) => endpoint))).toStrictEqual(new Set(['/platform/costs?from=2026-10-28&to=2026-11-26']))
  })
})
