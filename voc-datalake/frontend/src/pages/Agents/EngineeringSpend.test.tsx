/**
 * @fileoverview Agents → Spend (who sees the tab: Agents.test.tsx): the month's totals and its
 * groups (a workflow by its library name, a run linking to its monitor, MicroVM time and the models past a session's
 * first 8 by name); the month and the grouping as view options in the address; a workflow's row narrowing to its
 * runs and the filter cleared; an empty month, a read cut at its limit, and a failed read with its retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { monthsOffered, spendQueryOf } from './spendView'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringSpend } = await import('./EngineeringSpend')

/** A ledger total: dollars, then input and output tokens and MicroVM seconds. */
const usage = (usd: number, [tokensIn, tokensOut, seconds] = [0, 0, 0]) =>
  ({ usd, tokens_in: tokensIn, tokens_out: tokensOut, microvm_seconds: seconds })
const answer = (by: string, groups: { key: string }[], extra: Record<string, unknown> = {}) => ({
  month: '2026-11', by, total: usage(3.5, [300_000, 40_000, 7_200]), truncated: false, groups, ...extra,
})
const spendPath = (query: string) => `GET /agents/engineering/spend?${query}`
const BY_WORKFLOW = spendPath('month=2026-11&by=workflow')
const FIX_ROWS = { label: 'Fix the reported bugs: show its runs' }

/** The library's names and these spend reads. */
function route(routes: Record<string, RouteHandler>) {
  routeFetchApi({
    'GET /workflows': () => ({ items: [{ workflow_id: 'wf_fix', name: 'Fix the reported bugs' }] }),
    ...routes,
  }, { missStatus: 500 })
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname + location.search}</p>
}

function renderSpend(entry = '/agents?tab=spend&month=2026-11') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents" element={<><EngineeringSpend /><Where /></>} />
        <Route path="/agents/engineering/:runId" element={<p>Run monitor</p>} />
      </Routes>
    </TestRouter>,
  )
}

const where = () => new URLSearchParams(screen.getByTestId('where').textContent.split('?')[1] ?? '')

beforeEach(() => { resetFetchApi() })

describe('Agents → Spend: the month', () => {
  it('shows the month\'s totals', async () => {
    route({ [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(3.38) }]) })
    renderSpend()
    expect(await screen.findByText('$3.50')).toBeInTheDocument()
    expect(screen.getByText('300,000')).toBeInTheDocument()
    expect(screen.getByText('40,000')).toBeInTheDocument()
    expect(screen.getByText('2 hr')).toBeInTheDocument()
  })

  it('names each workflow by its library name, an unknown one by its id', async () => {
    route({ [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(3.38) }, { key: 'wf_gone', ...usage(0.12) }]) })
    renderSpend()
    const table = await screen.findByRole('table', { name: 'Spend in November 2026, grouped by: Workflow' })
    expect(within(table).getByRole('button', { name: FIX_ROWS.label })).toHaveTextContent('Fix the reported bugs')
    expect(within(table).getByRole('button', { name: 'wf_gone: show its runs' })).toBeInTheDocument()
    expect(within(table).getByText('$3.38')).toBeInTheDocument()
  })

  it('a workflow row narrows the view to its runs, each opening its monitor', async () => {
    const user = userEvent.setup()
    route({
      [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(3.38) }]),
      [spendPath('month=2026-11&by=run&workflow=wf_fix')]: () => answer('run', [{ key: 'RUN1', ...usage(3.38) }]),
    })
    renderSpend()
    await user.click(await screen.findByRole('button', { name: FIX_ROWS.label }))
    expect(await screen.findByRole('link', { name: 'RUN1' })).toHaveAttribute('href', '/agents/engineering/RUN1')
    expect(screen.getByText('Workflow: Fix the reported bugs')).toBeInTheDocument()
    expect(screen.getByLabelText('Group by')).toHaveValue('run')
    expect(Object.fromEntries(where())).toStrictEqual({ tab: 'spend', month: '2026-11', by: 'run', workflow: 'wf_fix' })
  })

  it('the workflow filter clears to every workflow\'s runs', async () => {
    const user = userEvent.setup()
    route({
      [spendPath('month=2026-11&by=run&workflow=wf_fix')]: () => answer('run', [{ key: 'RUN1', ...usage(3.38) }]),
      [spendPath('month=2026-11&by=run')]: () => answer('run', [{ key: 'RUN1', ...usage(3.38) }, { key: 'RUN2', ...usage(0.5) }]),
    })
    renderSpend('/agents?tab=spend&month=2026-11&by=run&workflow=wf_fix')
    await user.click(await screen.findByRole('button', { name: 'Show every workflow' }))
    expect(await screen.findByRole('link', { name: 'RUN2' })).toBeInTheDocument()
    expect(where().has('workflow')).toBe(false)
    expect(screen.queryByText(/^Workflow:/)).not.toBeInTheDocument()
  })

  it('a grouping picked is read and kept in the address; MicroVM time and the other models by name', async () => {
    const user = userEvent.setup()
    route({
      [BY_WORKFLOW]: () => answer('workflow', []),
      [spendPath('month=2026-11&by=model')]: () => answer('model', [
        { key: 'microvm', ...usage(0.1, [0, 0, 90]) }, { key: 'model-large', ...usage(0, [9_000, 800, 0]) }, { key: '-', ...usage(0, [100, 10, 0]) }]),
    })
    renderSpend()
    await user.selectOptions(await screen.findByLabelText('Group by'), 'model')
    const table = await screen.findByRole('table', { name: 'Spend in November 2026, grouped by: Model' })
    expect(within(table).getByRole('rowheader', { name: 'MicroVM time' })).toHaveTextContent('MicroVM time')
    expect(within(table).getByText('2 min')).toBeInTheDocument()
    expect(within(table).getByRole('rowheader', { name: 'Other models' })).toBeInTheDocument()
    expect(where().get('by')).toBe('model')
  })

  it('a month picked is read and kept in the address; an empty one says so', async () => {
    const user = userEvent.setup()
    route({
      [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(1) }]),
      [spendPath('month=2026-10&by=workflow')]: () => answer('workflow', [], { month: '2026-10' }),
    })
    renderSpend()
    await screen.findByRole('table')
    await user.selectOptions(screen.getByLabelText('Month'), '2026-10')
    expect(await screen.findByText('Nothing was spent in October 2026.')).toBeInTheDocument()
    expect(where().get('month')).toBe('2026-10')
  })

  it('an agent links to its run', async () => {
    route({ [spendPath('month=2026-11&by=agent')]: () => answer('agent', [{ key: 'RUN1/fixer-3', ...usage(1) }]) })
    renderSpend('/agents?tab=spend&month=2026-11&by=agent')
    const link = await screen.findByRole('link', { name: /fixer-3/ })
    expect(link).toHaveAttribute('href', '/agents/engineering/RUN1')
    expect(link).toHaveTextContent('in run RUN1')
  })

  it('an agent or a run not recorded says so, and a run not recorded links nowhere', async () => {
    route({ [spendPath('month=2026-11&by=agent')]: () => answer('agent', [{ key: 'RUN1/-', ...usage(1) }, { key: '-/-', ...usage(0.1) }]) })
    renderSpend('/agents?tab=spend&month=2026-11&by=agent')
    const rows = await screen.findAllByRole('rowheader')
    expect(rows.map((row) => row.textContent)).toStrictEqual(['Not recorded in run RUN1', 'Not recorded'])
    expect(within(rows[0] ?? document.body).getByRole('link')).toHaveAttribute('href', '/agents/engineering/RUN1')
    expect(within(rows[1] ?? document.body).queryByRole('link')).not.toBeInTheDocument()
  })

  it('a day reads as a date', async () => {
    route({ [spendPath('month=2026-11&by=day')]: () => answer('day', [{ key: '07', ...usage(1) }]) })
    renderSpend('/agents?tab=spend&month=2026-11&by=day')
    expect(await screen.findByRole('rowheader', { name: 'Nov 7' })).toBeInTheDocument()
  })

  it('a read cut at its limit says its figures are a lower bound', async () => {
    route({ [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(1) }], { truncated: true }) })
    renderSpend()
    expect(await screen.findByText(/figures shown are a lower bound/)).toBeInTheDocument()
    expect(screen.getByText('~$3.50')).toBeInTheDocument()
  })

  it('an unreadable answer is a failed read, never "nothing spent"', async () => {
    route({ [BY_WORKFLOW]: () => ({ month: '2026-11', groups: 'nope' }) })
    renderSpend()
    expect(await screen.findByText('The spend could not be loaded.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/Nothing was spent/)).not.toBeInTheDocument()
  })

  it('a failed read says so and retries', async () => {
    const user = userEvent.setup()
    route({ [BY_WORKFLOW]: () => { throw new ApiError(503, 'unavailable') } })
    renderSpend()
    expect(await screen.findByText('The spend could not be loaded.', {}, { timeout: 5000 })).toBeInTheDocument()
    route({ [BY_WORKFLOW]: () => answer('workflow', [{ key: 'wf_fix', ...usage(1) }]) })
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('The spend could not be loaded.')).not.toBeInTheDocument())
  })
})

describe('the Spend view options', () => {
  const now = new Date('2026-11-13T10:00:00Z')

  it('takes a month, a grouping and a workflow as the server would', () => {
    expect(spendQueryOf(new URLSearchParams('month=2026-02&by=repo&workflow=wf_1'), now))
      .toStrictEqual({ month: '2026-02', by: 'repo', workflow: 'wf_1' })
  })

  it('reads a bad one as the default', () => {
    expect(spendQueryOf(new URLSearchParams('month=2026-13&by=everything&workflow=a%23b'), now))
      .toStrictEqual({ month: '2026-11', by: 'workflow', workflow: '' })
    expect(spendQueryOf(new URLSearchParams(`workflow=${'w'.repeat(501)}`), now).workflow).toBe('')
    // (the server keeps 2000-2099 only: an older month would be a 400 no retry could fix)
    expect(spendQueryOf(new URLSearchParams('month=1999-01'), now).month).toBe('2026-11')
  })

  it('offers the last 24 months, newest first, and an older month asked for', () => {
    const months = monthsOffered('2026-11', now)
    expect(months).toHaveLength(24)
    expect(months.slice(0, 3)).toStrictEqual(['2026-11', '2026-10', '2026-09'])
    expect(months.at(-1)).toBe('2024-12')
    expect(monthsOffered('2020-01', now).at(-1)).toBe('2020-01')
  })
})
