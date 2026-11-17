/**
 * @fileoverview A connection's issues on Agents → Connections (ConnectionIssues.tsx, 7.50.02): on a connection made
 * through the deployment's GitHub App, "Read this repository's issues" (on by default) and whether the source reads
 * it, or why not, with its `voc-agent` label; the switch's PUT is the deployment's (no workspace header) and its
 * answer replaces the view; a source on a token points to its Data sources card; a connection not in the source's
 * list yet is read now on request; a connection with a pasted key, or a view that cannot be read, shows none; a
 * removal reads the view again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const connection = (id: string, kind: string) => ({
  connection_id: id, host: 'github', repository: `example-org/${id}`, default_branch: 'main',
  credential: { kind, set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: null,
  repository_private: true,
})
const BILLING = connection('billing-api', 'app_reference')
const PASTED = connection('pasted', 'app')
const entry = (id: string, fields: Record<string, unknown> = {}) => ({
  connection_id: id, repository: `example-org/${id}`, read: true, reading: true, reason: null, label: 'created', ...fields,
})
const view = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  deployed: true, signs_in: 'app', app_id: '271828', repositories: ['example-org/billing-api'],
  managed: ['example-org/billing-api'], schedule: 'on', label: 'voc-agent', connections: entries, ...extra,
})
const ISSUES = 'GET /agents/engineering/issues-source'
const SWITCH = '/agents/engineering/connections/billing-api/issues'

function renderConnections(routes: Record<string, RouteHandler>) {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections: [BILLING, PASTED], limit: 20 }),
    'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }),
    ...routes,
  }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, createTestQueryClient())
}

const issuesOf = async (id: string) => within(await screen.findByTestId(`connection-issues-${id}`))

beforeEach(() => { resetFetchApi() })

describe('a connection\'s issues', () => {
  it('are read by default on a connection made through the App, with its label', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api'), entry('pasted', { reading: false, reason: 'not_app', label: null })]) })
    const billing = await issuesOf('billing-api')
    expect(billing.getByRole('switch', { name: 'Read this repository\'s issues' })).toBeChecked()
    expect([billing.getByText('Issues are read automatically.'), billing.getByText('Label voc-agent: created.')]).toHaveLength(2)
    // (a pasted key's connection is not the App's: no switch, no line)
    expect(screen.queryByTestId('connection-issues-pasted')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('are switched off through the deployment\'s PUT, and the answer is shown', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api')]),
      [`PUT ${SWITCH}`]: () => view([entry('billing-api', { read: false, reading: false, reason: 'off', label: 'created' })]),
    })
    const billing = await issuesOf('billing-api')
    await userEvent.click(billing.getByRole('switch', { name: 'Read this repository\'s issues' }))
    expect(await billing.findByText('Its issues are not read: the switch is off.')).toBeInTheDocument()
    expect(billing.getByRole('switch', { name: 'Read this repository\'s issues' })).not.toBeChecked()
    expect(sentFetchApiBody(SWITCH, 'PUT')).toStrictEqual({ read: false })
    // (both the deployment's: no X-Workspace-Id)
    expect(new Set(fetchApi.mock.calls.filter(([path]) => path === SWITCH || path === '/agents/engineering/issues-source')
      .map((call) => call[2]))).toStrictEqual(new Set(['deployment']))
  })

  it('say the server\'s refusal in its words', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api')]),
      [`PUT ${SWITCH}`]: () => { throw new ApiError(409, 'the GitHub Issues source is not deployed here') },
    })
    const billing = await issuesOf('billing-api')
    await userEvent.click(billing.getByRole('switch', { name: 'Read this repository\'s issues' }))
    expect(await billing.findByRole('alert')).toHaveTextContent('the GitHub Issues source is not deployed here')
  })

  it('point to the GitHub Issues card when the source signs in with a token', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'token', label: 'present' })],
      { signs_in: 'token', app_id: null }) })
    const billing = await issuesOf('billing-api')
    expect(billing.getByText(/signs in with a token: add this repository under Administration → Data sources/)).toBeInTheDocument()
    expect(billing.getByRole('link', { name: 'Open Administration → Data sources' })).toHaveAttribute('href', '/admin/sources/github_issues?scope=deployment')
    expect(billing.getByText('Label voc-agent: on the repository.')).toBeInTheDocument()
  })

  it('are read now on request for a connection not in the source\'s list yet', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'pending', label: null })]),
      [`PUT ${SWITCH}`]: () => view([entry('billing-api')]),
    })
    const billing = await issuesOf('billing-api')
    expect(billing.getByText('Not read yet: it is not in the GitHub Issues source\'s list.')).toBeInTheDocument()
    await userEvent.click(billing.getByRole('button', { name: 'Read its issues now' }))
    expect(await billing.findByText('Issues are read automatically.')).toBeInTheDocument()
    expect(sentFetchApiBody(SWITCH, 'PUT')).toStrictEqual({ read: true })
  })

  it('say a reason they do not know as a plain "not read", and a label that could not be made', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'mystery', label: 'failed' })]) })
    const billing = await issuesOf('billing-api')
    expect([billing.getByText('Its issues are not read.'),
      billing.getByText('The voc-agent label could not be created: Check installation tries again.')]).toHaveLength(2)
  })

  it('show no switch where the source is not deployed', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'not_deployed', label: null })],
      { deployed: false }) })
    const billing = await issuesOf('billing-api')
    expect(billing.queryByRole('switch')).toBeNull()
    expect(billing.getByText('The GitHub Issues source is not deployed here, so no issues are read.')).toBeInTheDocument()
  })

  it('show nothing while the view cannot be read', async () => {
    renderConnections({})
    expect(await screen.findByText('example-org/billing-api')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('are read again once a connection is removed', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api')]),
      'DELETE /agents/engineering/connections/billing-api': () => ({ removed: true }),
    })
    await issuesOf('billing-api')
    const reads = () => fetchApi.mock.calls.filter(([path]) => path === '/agents/engineering/issues-source').length
    const before = reads()
    await userEvent.click(screen.getByRole('button', { name: 'Remove example-org/billing-api' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove connection' }))
    await waitFor(() => { expect(reads()).toBeGreaterThan(before) })
  })
})
