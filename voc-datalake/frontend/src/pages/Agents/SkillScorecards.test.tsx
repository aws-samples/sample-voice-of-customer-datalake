/**
 * @fileoverview Agents → Skills → a role's scorecards: none for the shared skills (pick a connection), the server's
 * default versions in a table, the versions a person names (checked first, with what to fix), and the empty and
 * failed states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SkillScorecards } = await import('./SkillScorecards')

const DEFAULT = 'GET /agents/engineering/scorecards/fixer?connection=storefront'
const card = (version: number, fields: Record<string, unknown> = {}) => ({
  version, source: 'shipped', label: `fixer@${String(version)}`, runs: 4, pass_rate: 0.75, tasks_done: 6, tasks_failed: 1, needs_human: 1,
  reposts: 0, review_rounds: 5, attempts: 8, cost_usd: 1.5, seconds: 1_800, more: false, ...fields,
})

function renderScores(routes: Record<string, RouteHandler>, connection = 'storefront') {
  routeFetchApi(routes, { missStatus: 500 })
  renderWithQueryClient(<SkillScorecards connection={connection} role="fixer" />)
}

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a role\'s scorecards', () => {
  it('says the shared skills have none and reads nothing', () => {
    renderScores({}, '')
    expect(screen.getByText(/Scorecards belong to a connection/)).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('compares the default versions: pass rate, tasks, review rounds, attempts, cost and time', async () => {
    renderScores({ [DEFAULT]: () => ({ versions: [2, 1], cards: [card(2), card(1, { pass_rate: null, runs: 0 })] }) })
    const table = await screen.findByRole('table', { name: 'Scorecards of Fixer' })
    const rows = within(table).getAllByRole('row')
    expect(rows.map((row) => within(row).queryByRole('rowheader')?.textContent ?? '')).toStrictEqual(['', 'Version 2', 'Version 1'])
    const newest = within(table).getByRole('row', { name: /^Version 2/ })
    expect(within(newest).getAllByRole('cell').map((cell) => cell.textContent)).toStrictEqual(
      ['Shipped skill', '75%', '4', '6', '1', '1', '5', '8', '$1.50', '30 min'])
  })

  it('says plainly that the sessions do not name a version\'s scope, and labels a source it does not know as such', async () => {
    renderScores({ [DEFAULT]: () => ({ scope_known: false, versions: [1], cards: [card(1, { source: 'elsewhere' })] }) })
    expect(await screen.findByText(/These numbers are the shipped skills’ versions, not the history’s above/)).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /^Version 1/ })).getAllByRole('cell')[0]).toHaveTextContent('Not known')
  })

  it('reads the versions a person names', async () => {
    renderScores({
      [DEFAULT]: () => ({ versions: [2], cards: [card(2)] }),
      [`${DEFAULT}&versions=3%2C1`]: () => ({ versions: [3, 1], cards: [card(3), card(1)] }),
    })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Versions to compare' }), '3, 1')
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(await screen.findByRole('rowheader', { name: 'Version 3' })).toBeInTheDocument()
  })

  it.each([
    ['', 'Type at least one version number, such as 3, 2.'],
    ['2, x', 'Use whole version numbers from 1, separated by commas.'],
    ['1,2,3,4,5,6,7,8,9,10,11', 'Compare at most 10 versions at once.'],
    ['2, 2', 'Name each version once.'],
  ])('says what to fix in %j', async (typed, said) => {
    renderScores({ [DEFAULT]: () => ({ versions: [], cards: [] }) })
    const field = await screen.findByRole('textbox', { name: 'Versions to compare' })
    await userEvent.type(field, `${typed}{Enter}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(said)
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('says when the connection has no scorecards for these versions', async () => {
    renderScores({ [DEFAULT]: () => ({ versions: [], cards: [] }) })
    expect(await screen.findByText('No scorecards for these versions on this connection yet.')).toBeInTheDocument()
  })

  it('says a failed read failed', async () => {
    renderScores({})
    expect(await screen.findByRole('alert')).toHaveTextContent('The scorecards could not be loaded. Try again in a moment.')
  })
})
