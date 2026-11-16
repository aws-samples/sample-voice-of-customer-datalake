/**
 * @fileoverview Agents → Connections, "Connect GitHub" (GitHubAppPanel.tsx, 7.45.00): the form posted to github.com
 * is the server's (its address and its manifest, never built here), sent once; an organization's login is checked
 * before anything is sent; each App's row says its account, its webhook and its connections ("Not installed" for
 * none) with Install / Install more (the server's link, opened in this tab), Check installation and Remove (the
 * server's 409 said in its words); a connection made through an App says which ("via <slug>").
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { stubLocationAssign } from '@test/location'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const app = (fields: Record<string, unknown> = {}) => ({
  app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: ['billing-api'],
  created_at: '2026-11-10T10:00:00Z', created_by: 'admin-a', version: 1, ...fields,
})
const FRESH = app({ app_id: '314159', slug: 'voc-agents-314159', owner: 'alice', owner_type: 'User', webhook: false, connections: [] })
const BILLING = {
  connection_id: 'billing-api', host: 'github', repository: 'example-org/billing-api', default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: null,
  repository_private: true,
}
const APPS = 'GET /agents/engineering/github-apps'
const MANIFEST = 'POST /agents/engineering/github-apps/manifest'
const ACTION_URL = 'https://github.com/settings/apps/new?state=s1'
const MANIFEST_BODY = { name: 'VoC Autonomous Agent 3f9a', public: false, default_permissions: { issues: 'write' } }

function renderPanel(routes: Record<string, RouteHandler> = {}, apps: unknown[] = [app(), FRESH], limit = 5) {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections: [BILLING], limit: 20 }),
    [APPS]: () => ({ apps, limit }), ...routes,
  }, { missStatus: 500 })
  // (StrictMode, as main.tsx renders the app: its effects run twice, and the form is still posted once)
  renderWithQueryClient(<StrictMode><EngineeringConnections /></StrictMode>, createTestQueryClient())
}

const appRow = async (slug: string) => {
  const list = await screen.findByRole('list', { name: 'GitHub Apps' })
  const row = within(list).getByText(slug).closest('li')
  if (row === null) throw new Error(`no row for ${slug}`)
  return within(row)
}

const submit = vi.spyOn(HTMLFormElement.prototype, 'submit')

beforeEach(() => {
  resetFetchApi()
  submit.mockReset().mockReturnValue(undefined)
})
afterEach(() => { submit.mockReset() })

describe('the deployment\'s GitHub Apps', () => {
  it('lists each App with its account, its webhook and its connections', async () => {
    renderPanel()
    const row = await appRow('voc-agents-3f9a2c')
    expect([row.getByText('example-org (organization)'), row.getByText('Issue events delivered here'),
      row.getByText('1 connection')]).toHaveLength(3)
    expect(row.getByRole('button', { name: 'Install voc-agents-3f9a2c on GitHub' })).toHaveTextContent('Install more')
    expect(row.getByRole('button', { name: 'Check the installation of voc-agents-3f9a2c' })).toBeInTheDocument()
  })

  it('says an App with no connection is not installed, offering Install and Remove only', async () => {
    renderPanel()
    const row = await appRow('voc-agents-314159')
    expect([row.getByText('Not installed'), row.getByText('alice (personal account)'), row.getByText('No webhook')]).toHaveLength(3)
    expect(row.getByRole('button', { name: 'Install voc-agents-314159 on GitHub' })).toHaveTextContent(/^Install$/)
    expect(row.queryByRole('button', { name: /Check the installation/ })).not.toBeInTheDocument()
  })

  it('says which App a connection goes through', async () => {
    renderPanel()
    expect(await screen.findByText('via voc-agents-3f9a2c')).toBeInTheDocument()
  })

  it('offers no new App at the limit', async () => {
    renderPanel({}, [app()], 1)
    expect(await screen.findByText(/at most 1 GitHub Apps/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create the App on GitHub' })).toBeDisabled()
  })
})

describe('creating an App', () => {
  it('posts the server\'s form to github.com once: its address and its manifest as they came', async () => {
    const user = userEvent.setup()
    renderPanel({ [MANIFEST]: () => ({ action_url: ACTION_URL, manifest: MANIFEST_BODY, expires_at: 'later' }) })
    await user.click(await screen.findByRole('button', { name: 'Create the App on GitHub' }))
    await waitFor(() => { expect(submit).toHaveBeenCalledExactlyOnceWith() })
    const form = screen.getByTestId('github-manifest-form')
    expect(sentFetchApiBody('/agents/engineering/github-apps/manifest', 'POST')).toStrictEqual({ account: 'user' })
    expect([form.getAttribute('action'), form.getAttribute('method'), form.querySelector('input[name="manifest"]')?.getAttribute('value')])
      .toStrictEqual([ACTION_URL, 'post', JSON.stringify(MANIFEST_BODY)])
  })

  it('checks an organization\'s login before anything is sent, then sends it', async () => {
    const user = userEvent.setup()
    renderPanel({ [MANIFEST]: () => ({ action_url: ACTION_URL, manifest: MANIFEST_BODY, expires_at: 'later' }) })
    await user.click(await screen.findByRole('radio', { name: 'An organization' }))
    await user.type(screen.getByLabelText('Organization'), 'bad--name')
    await user.click(screen.getByRole('button', { name: 'Create the App on GitHub' }))
    expect(screen.getByText(/letters, digits and single hyphens/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Organization'))
    await user.type(screen.getByLabelText('Organization'), 'example-org')
    await user.click(screen.getByRole('button', { name: 'Create the App on GitHub' }))
    await waitFor(() => { expect(sentFetchApiBody('/agents/engineering/github-apps/manifest', 'POST')).toStrictEqual({ account: 'organization', org: 'example-org' }) })
  })

  it('says the server\'s refusal in its words, and posts nothing', async () => {
    const user = userEvent.setup()
    renderPanel({ [MANIFEST]: () => { throw new ApiError(409, 'at most 5 GitHub Apps: remove one to create another') } })
    await user.click(await screen.findByRole('button', { name: 'Create the App on GitHub' }))
    expect(await screen.findByText('at most 5 GitHub Apps: remove one to create another')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('an App\'s actions', () => {
  it('opens the server\'s install link in this tab', async () => {
    const user = userEvent.setup()
    const assign = stubLocationAssign('/agents')
    const link = 'https://github.com/apps/voc-agents-3f9a2c/installations/new?state=s3'
    renderPanel({ 'POST /agents/engineering/github-apps/271828/install': () => ({ install_url: link, expires_at: 'later' }) })
    await user.click((await appRow('voc-agents-3f9a2c')).getByRole('button', { name: 'Install voc-agents-3f9a2c on GitHub' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(link) })
  })

  it('says which connections the installation no longer covers', async () => {
    const user = userEvent.setup()
    renderPanel({ 'POST /agents/engineering/github-apps/271828/check': () => ({ repositories: [], missing: ['billing-api'] }) })
    await user.click((await appRow('voc-agents-3f9a2c')).getByRole('button', { name: 'Check the installation of voc-agents-3f9a2c' }))
    expect(await screen.findByText(/No longer covered by the installation: billing-api/)).toBeInTheDocument()
  })

  it('says the server\'s 409 when connections still use the App it removes', async () => {
    const user = userEvent.setup()
    renderPanel({ 'DELETE /agents/engineering/github-apps/271828': () => { throw new ApiError(409, '1 connection(s) use this App: remove them first') } })
    await user.click((await appRow('voc-agents-3f9a2c')).getByRole('button', { name: 'Remove voc-agents-3f9a2c' }))
    await user.click(screen.getByRole('button', { name: 'Remove the App' }))
    expect(await screen.findByText('1 connection(s) use this App: remove them first')).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
  })
})
