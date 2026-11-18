/**
 * @fileoverview Agents → Skills (who sees the tab: Agents.test.tsx): a scope's roles (the shared skills or a
 * connection's), their empty and failed states, the scope and the role as view options in the address, and a role's
 * history opening from its row. Read only: no button acts on a version.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import Where from '@test/LocationWhere'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringSkills } = await import('./EngineeringSkills')

const SHARED_ROLES = 'GET /agents/engineering/skills?connection='
const FIXER = {
  role: 'fixer', current_version: 3, versions: 3,
  latest: { version: 3, status: 'accepted', summary: 'Fixer skill proposed: v1 → v3, one more example', proposed_at: '2026-11-10T09:00:00Z' },
}

function route(routes: Record<string, RouteHandler>) {
  routeFetchApi({ 'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }), ...routes }, { missStatus: 500 })
}

function renderSkills(entry = '/agents/skills') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        {['/agents', '/agents/skills/*'].map((path) => <Route key={path} path={path} element={<><EngineeringSkills /><Where /></>} />)}
      </Routes>
    </TestRouter>,
  )
}

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a scope\'s roles', () => {
  it('lists each shared role with its current version, its count and its newest change', async () => {
    route({ [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER] }) })
    renderSkills()
    const table = await screen.findByRole('table', { name: 'Agent roles with a skill version in this scope' })
    expect(within(table).getByRole('button', { name: 'Open the history of Fixer' })).toBeInTheDocument()
    expect(within(table).getByText('Fixer skill proposed: v1 → v3, one more example')).toBeInTheDocument()
    expect(within(table).getByText('Current')).toBeInTheDocument()
  })

  it('says the agents run the shipped skills while no shared skill has a version', async () => {
    route({ [SHARED_ROLES]: () => ({ connection: '', roles: [] }) })
    renderSkills()
    expect(await screen.findByText(/No shared skill has a version yet/)).toBeInTheDocument()
  })

  it('says a connection with no versions of its own uses the shared skills', async () => {
    route({ 'GET /agents/engineering/skills?connection=storefront': () => ({ connection: 'storefront', roles: [] }) })
    renderSkills('/agents?tab=skills&connection=storefront')
    expect(await screen.findByText(/This connection has no skill versions of its own/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Skills of' })).toHaveValue('storefront')
  })

  it('says a failed read failed, never that there are no skills, and offers a retry', async () => {
    route({})
    renderSkills()
    expect(await screen.findByRole('alert')).toHaveTextContent('The skills could not be loaded. Try again in a moment.')
    expect(screen.getByRole('button', { name: /Try again|Retry/ })).toBeInTheDocument()
    expect(screen.queryByText(/No shared skill/)).not.toBeInTheDocument()
  })

  it('opens a role\'s history from its row, with the role in the address, and offers no action on a version', async () => {
    route({
      [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER] }),
      'GET /agents/engineering/skills/fixer/versions?connection=': () => ({ current_version: 3, versions: [], next_page: null }),
    })
    renderSkills()
    await userEvent.click(await screen.findByRole('button', { name: 'Open the history of Fixer' }))
    expect(await screen.findByRole('heading', { name: 'Fixer · Shared skills' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/agents\/skills\/fixer$/)
    expect(screen.queryByRole('button', { name: /Accept|Reject|Roll back/ })).not.toBeInTheDocument()
  })

  it('picks another scope, leaving the role behind', async () => {
    route({
      [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER] }),
      'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
      'GET /agents/engineering/skills?connection=storefront': () => ({ connection: 'storefront', roles: [] }),
    })
    renderSkills('/agents/skills/fixer/versions/2?connection=storefront')
    await userEvent.click(await screen.findByRole('button', { name: 'All roles' }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Skills of' }), 'Shared skills')
    expect(await screen.findByRole('button', { name: 'Open the history of Fixer' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/agents\/skills$/)
  })
})

describe('Agents → Skills, its role and version as paths', () => {
  it('opens a version from its path, Back returns to the history and the scope stays in the query', async () => {
    route({
      'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
      'GET /agents/engineering/skills?connection=storefront': () => ({ connection: 'storefront', roles: [FIXER] }),
      'GET /agents/engineering/skills/fixer/versions?connection=storefront': () => ({ current_version: 3, versions: [], next_page: null }),
      'GET /agents/engineering/skills/fixer/versions/2?connection=storefront': () => ({ connection: 'storefront', role: 'fixer', version: null }),
      'GET /agents/engineering/scorecards/fixer?connection=storefront': () => ({ connection: 'storefront', role: 'fixer', versions: [], cards: [] }),
    })
    renderSkills('/agents/skills/fixer/versions/2?connection=storefront')
    expect(await screen.findByRole('heading', { name: 'Fixer · v2' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/agents\/skills\/fixer\/versions\/2\?connection=storefront$/)
  })
})

describe('Agents → Skills: what waits for review, and a newer template (7.52.00)', () => {
  const HUNTER = {
    role: 'hunter', current_version: 4, versions: 5,
    latest: { version: 5, status: 'proposed', summary: 'Ask for the failing test first', proposed_at: '2026-11-16T09:00:00Z' },
  }
  const REGISTRY = 'GET /agents/engineering/registry'
  const roleCard = (id: string, newer: boolean) => ({
    kind: 'role', id, template: { version: 4, label: `${id}@template-4`, digest: 'sha256:x' }, skill: { template_newer: newer },
  })

  it('lists a role with a proposal waiting first, and Review opens that version', async () => {
    route({ [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER, HUNTER] }), [REGISTRY]: () => ({ cards: [] }) })
    renderSkills()
    const table = await screen.findByRole('table', { name: 'Agent roles with a skill version in this scope' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Bug hunter')
    expect(within(table).getByText('v5 to review')).toHaveClass('badge', 'badge-warn')
    await userEvent.click(within(table).getByRole('button', { name: 'Review version 5 of Bug hunter' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/agents\/skills\/hunter\/versions\/5$/)
  })

  it('says a newer template in badge-info, from the Registry\'s cards', async () => {
    route({ [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER] }), [REGISTRY]: () => ({ cards: [roleCard('fixer', true)] }) })
    renderSkills()
    const table = await screen.findByRole('table', { name: 'Agent roles with a skill version in this scope' })
    expect(await within(table).findByText('Update available (v4)')).toHaveClass('badge', 'badge-info')
  })

  it('opens a version from the history beside it, as a sheet with Open full page', async () => {
    const line = { version: 3, status: 'accepted', summary: 'One more example', why: { run_id: '', failure: '', comment: '' },
      proposed_by: 'alice', proposed_by_kind: 'person', proposed_at: '2026-11-10T09:00:00Z', base: null,
      benchmark: { claimed: null, measured: null }, events: [] }
    route({
      [SHARED_ROLES]: () => ({ connection: '', roles: [FIXER] }),
      'GET /agents/engineering/skills/fixer/versions?connection=': () => ({ current_version: 3, versions: [line], next_page: null }),
      'GET /agents/engineering/skills/fixer/versions/3?connection=': () => ({ connection: '', role: 'fixer', version: { ...line,
        record: { instructions: '## Steps\n\nPlan the smallest fix.', examples: [], tool_policy: ['read_file'], model: 'm', harness: 'converse' },
        diff: { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: true },
      } }),
    })
    renderSkills('/agents/skills/fixer')
    await userEvent.click(await screen.findByRole('button', { name: 'Open version 3 and its changes' }))
    const sheet = await screen.findByRole('dialog', { name: 'Fixer · v3' })
    expect(await within(sheet).findByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(within(sheet).getByRole('link', { name: /Open full page/ })).toHaveAttribute('href', '/agents/skills/fixer/versions/3')
  })
})
