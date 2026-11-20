/**
 * @fileoverview A connection's issues on Agents → Connections (ConnectionIssues.tsx, 7.50.02; a row's Issues and Label
 * columns since 7.52.00): on a connection made through the deployment's GitHub App, "Read this repository's issues"
 * (on by default) with its state as visible text ("Reading", "Off") and why the source does not read it when it does
 * not, and its `voc-agent` label as a chip; the switch's PUT is the deployment's (no workspace header) and its answer
 * replaces the view, with no confirmation to turn it off; a source on a token points to its Data sources card; a
 * connection not in the source's list yet is read now on request; a label that could not be created makes Create label
 * the row's action (the App's check); a connection with a pasted key, or a view that cannot be read, shows no switch;
 * the page's status line says "Issues read automatically" only while one is; a removal reads the view again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { chooseInRowMenu } from '@test/connectionDialog'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const ATTESTED = { version: 1, state: 'attested', repository: 'example-org/billing-api', points: [], by: 'admin-a', at: null, reason: null, cause: null }
const connection = (id: string, kind: string, ciAttestation: unknown = null) => ({
  connection_id: id, host: 'github', repository: `example-org/${id}`, default_branch: 'main',
  credential: { kind, set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: ciAttestation,
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
const SWITCH_NAME = 'Read this repository\'s issues'

function renderConnections(routes: Record<string, RouteHandler>, connections: unknown[] = [BILLING, PASTED]) {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections, limit: 20 }),
    'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }),
    ...routes,
  }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, createTestQueryClient())
}

const issuesOf = async (id: string) => within(await screen.findByTestId(`connection-issues-${id}`))
const rowOf = async (id: string) => within(await screen.findByTestId(`connection-row-${id}`))

beforeEach(() => { resetFetchApi() })

describe('a connection\'s issues', () => {
  it('are read by default on a connection made through the App, with its label as a chip', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api'), entry('pasted', { reading: false, reason: 'not_app', label: null })]) })
    const billing = await issuesOf('billing-api')
    const label = (await rowOf('billing-api')).getByText('voc-agent')
    // (the switch is a native checkbox with role="switch": its state is the input's own `checked`)
    expect([billing.queryByRole('switch', { name: SWITCH_NAME, checked: true }) !== null, billing.queryByText('Reading') !== null,
      label.classList.contains('badge-ok')]).toStrictEqual([true, true, true])
    // (a pasted key's connection is not the App's: no switch, a dash said to a screen reader)
    const dash = (await rowOf('pasted')).getByText('Read only through the deployment’s GitHub App')
    expect([screen.queryByTestId('connection-issues-pasted'), dash.classList.contains('sr-only'), screen.getAllByRole('switch').length])
      .toStrictEqual([null, true, 1])
    expect(screen.getByTestId('connections-status')).toHaveTextContent('Issues read automatically')
  })

  it('are switched off through the deployment\'s PUT, with no confirmation, and the answer is shown', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api')]),
      [`PUT ${SWITCH}`]: () => view([entry('billing-api', { read: false, reading: false, reason: 'off', label: 'created' })]),
    })
    const billing = await issuesOf('billing-api')
    await userEvent.click(billing.getByRole('switch', { name: SWITCH_NAME }))
    expect(await billing.findByText('Its issues are not read: the switch is off.')).toBeInTheDocument()
    expect([billing.getByRole('switch', { name: SWITCH_NAME }), billing.getByText('Off'), screen.queryByRole('dialog'),
      sentFetchApiBody(SWITCH, 'PUT'), screen.getByTestId('connections-status').textContent.includes('Issues read automatically')])
      .toStrictEqual([expect.not.objectContaining({ checked: true }), expect.anything(), null, { read: false }, false])
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
    await userEvent.click(billing.getByRole('switch', { name: SWITCH_NAME }))
    expect(await billing.findByRole('alert')).toHaveTextContent('the GitHub Issues source is not deployed here')
  })

  it('point to the GitHub Issues card when the source signs in with a token', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'token', label: 'present' })],
      { signs_in: 'token', app_id: null }) })
    const billing = await issuesOf('billing-api')
    expect(billing.getByText(/signs in with a token: add this repository under Administration → Sources → Source settings/)).toBeInTheDocument()
    expect(billing.getByRole('link', { name: 'Open Administration → Sources → Source settings' })).toHaveAttribute('href', '/admin/sources/plugins/github_issues?scope=deployment')
    expect(billing.getByText('Not read')).toBeInTheDocument()
    expect((await rowOf('billing-api')).getByText('voc-agent')).toBeInTheDocument()
  })

  it('are read now on request for a connection not in the source\'s list yet', async () => {
    renderConnections({
      [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'pending', label: null })]),
      [`PUT ${SWITCH}`]: () => view([entry('billing-api')]),
    })
    const billing = await issuesOf('billing-api')
    expect(billing.getByText('Not read yet: it is not in the GitHub Issues source\'s list.')).toBeInTheDocument()
    await userEvent.click(billing.getByRole('button', { name: 'Read its issues now' }))
    expect(await billing.findByText('Reading')).toBeInTheDocument()
    expect(sentFetchApiBody(SWITCH, 'PUT')).toStrictEqual({ read: true })
  })

  it('say a reason they do not know as a plain "not read", and a label that could not be made as a danger chip', async () => {
    renderConnections({ [ISSUES]: () => view([entry('billing-api', { reading: false, reason: 'mystery', label: 'failed' })]) })
    const billing = await issuesOf('billing-api')
    expect(billing.getByText('Its issues are not read.')).toBeInTheDocument()
    expect((await rowOf('billing-api')).getByText('Couldn’t create')).toHaveClass('badge-danger')
  })

  it('make Create label the row\'s action once its CI is attested, the App\'s check making the label again', async () => {
    const check = vi.fn(() => ({ repositories: ['example-org/billing-api'], missing: [] }))
    renderConnections({
      [ISSUES]: () => view([entry('billing-api', { label: 'failed' })]),
      'POST /agents/engineering/github-apps/271828/check': check,
    }, [connection('billing-api', 'app_reference', ATTESTED)])
    await userEvent.click((await rowOf('billing-api')).getByRole('button', { name: 'Create label example-org/billing-api' }))
    await waitFor(() => { expect(check).toHaveBeenCalledTimes(1) })
    expect(screen.getByTestId('connections-status')).toHaveTextContent('Needs attention')
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
    await chooseInRowMenu('Actions for example-org/billing-api', 'Remove connection…')
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove connection' }))
    await waitFor(() => { expect(reads()).toBeGreaterThan(before) })
  })
})
