/**
 * @fileoverview Agents → Connections' GitHub Apps (7.45.00; 7.52.00 AppGroup.tsx and GitHubAppPanel.tsx): each App is a
 * card whose header says its account, whether it sends issue events, Installed · N repositories or Not installed, with
 * Install on GitHub or Add repositories (the server's link, opened in this tab) and a "⋯" (Open on GitHub, Check
 * installation, Remove App…), its repositories as rows under it; a check that finds repositories no longer covered
 * offers Reinstall on GitHub; Check now checks every installed App; once an App is connected there is no create form in
 * view (it folds under More ways to connect, a secondary button); while nothing is connected the form posted to
 * github.com is the server's (its address and its manifest, never built here), sent once, and an organization's login
 * is checked before anything is sent.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { stubLocationAssign } from '@test/location'
import { chooseInRowMenu } from '@test/connectionDialog'
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
const LIST = 'GET /agents/engineering/connections'
const MANIFEST = 'POST /agents/engineering/github-apps/manifest'
const CHECK = 'POST /agents/engineering/github-apps/271828/check'
const ACTION_URL = 'https://github.com/settings/apps/new?state=s1'
const MANIFEST_BODY = { name: 'VoC Autonomous Agent 3f9a', public: false, default_permissions: { issues: 'write' } }

function renderPanel(routes: Record<string, RouteHandler> = {}, apps: unknown[] = [app(), FRESH], limit = 5,
  connections: unknown[] = [BILLING]) {
  routeFetchApi({ [LIST]: () => ({ connections, limit: 20 }), [APPS]: () => ({ apps, limit }), ...routes }, { missStatus: 500 })
  // (StrictMode, as main.tsx renders the app: its effects run twice, and the form is still posted once)
  renderWithQueryClient(<StrictMode><TestRouter><EngineeringConnections /></TestRouter></StrictMode>, createTestQueryClient())
}

/** Nothing connected: no App, no connection (the hero's form). */
const renderNothing = (routes: Record<string, RouteHandler> = {}) => { renderPanel(routes, [], 5, []) }

const appCard = async (slug: string) => within(await screen.findByRole('region', { name: slug }))
const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

const submit = vi.spyOn(HTMLFormElement.prototype, 'submit')

beforeEach(() => {
  resetFetchApi()
  submit.mockReset().mockReturnValue(undefined)
})
afterEach(() => { submit.mockReset() })

describe('the deployment\'s GitHub Apps', () => {
  it('shows each App with its account, its webhook and its repositories as rows under it', async () => {
    renderPanel()
    const card = await appCard('voc-agents-3f9a2c')
    expect([card.getByText('example-org (organization)'), card.getByText('Sends issue events'),
      card.getByText('Installed · 1 repository'), card.getByRole('button', { name: 'Add repositories voc-agents-3f9a2c' })])
      .toHaveLength(4)
    expect(within(card.getByRole('list', { name: 'Repositories through voc-agents-3f9a2c' })).getByText('example-org/billing-api'))
      .toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Other connections' })).not.toBeInTheDocument()
  })

  it('says an App with no connection is not installed, its one action Install on GitHub', async () => {
    renderPanel()
    const card = await appCard('voc-agents-314159')
    expect([card.getByText('Not installed'), card.getByText('alice (personal account)'), card.getByText('No webhook'),
      card.getByRole('button', { name: 'Install on GitHub voc-agents-314159' })]).toHaveLength(4)
    expect(screen.getByTestId('connections-status')).toHaveTextContent('Needs attention')
  })

  it('offers Open on GitHub, Check installation and Remove App… in an App\'s "⋯" (no check for one installed nowhere)', async () => {
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for voc-agents-3f9a2c' }))
    expect(menuItems()).toStrictEqual(['Open voc-agents-3f9a2c on GitHub', 'Check installation', 'Remove App…'])
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Actions for voc-agents-314159' }))
    expect(menuItems()).toStrictEqual(['Open voc-agents-314159 on GitHub', 'Remove App…'])
  })

  it('shows no create form once an App is connected: it folds under More ways to connect, a secondary button', async () => {
    renderPanel()
    await appCard('voc-agents-3f9a2c')
    expect([screen.queryByRole('region', { name: 'Connect GitHub' }), screen.queryByRole('button', { name: 'Create the App on GitHub' })])
      .toStrictEqual([null, null])
    const fold = screen.getByRole('button', { name: /^Add another GitHub App/ })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(fold)
    expect(screen.getByRole('button', { name: 'Create the App on GitHub' })).toHaveClass('btn-secondary')
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(0)
  })

  it('offers no new App at the limit', async () => {
    renderPanel({}, [app()], 1)
    await userEvent.click(await screen.findByRole('button', { name: /^Add another GitHub App/ }))
    expect(screen.getByText(/at most 1 GitHub Apps/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create the App on GitHub' })).toBeDisabled()
  })
})

describe('creating an App while nothing is connected', () => {
  it('posts the server\'s form to github.com once: its address and its manifest as they came', async () => {
    const user = userEvent.setup()
    renderNothing({ [MANIFEST]: () => ({ action_url: ACTION_URL, manifest: MANIFEST_BODY, expires_at: 'later' }) })
    await user.click(await screen.findByRole('button', { name: 'Create the App on GitHub' }))
    await waitFor(() => { expect(submit).toHaveBeenCalledExactlyOnceWith() })
    const form = screen.getByTestId('github-manifest-form')
    expect(sentFetchApiBody('/agents/engineering/github-apps/manifest', 'POST')).toStrictEqual({ account: 'user' })
    expect([form.getAttribute('action'), form.getAttribute('method'), form.querySelector('input[name="manifest"]')?.getAttribute('value')])
      .toStrictEqual([ACTION_URL, 'post', JSON.stringify(MANIFEST_BODY)])
  })

  it('checks an organization\'s login before anything is sent, then sends it', async () => {
    const user = userEvent.setup()
    renderNothing({ [MANIFEST]: () => ({ action_url: ACTION_URL, manifest: MANIFEST_BODY, expires_at: 'later' }) })
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
    renderNothing({ [MANIFEST]: () => { throw new ApiError(409, 'at most 5 GitHub Apps: remove one to create another') } })
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
    await user.click((await appCard('voc-agents-3f9a2c')).getByRole('button', { name: 'Add repositories voc-agents-3f9a2c' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(link) })
  })

  it('offers Reinstall on GitHub when a check finds repositories the installation no longer covers', async () => {
    renderPanel({ [CHECK]: () => ({ repositories: [], missing: ['billing-api'] }) })
    await chooseInRowMenu('Actions for voc-agents-3f9a2c', 'Check installation')
    const card = await appCard('voc-agents-3f9a2c')
    expect(await card.findByText(/No longer covered by the installation: billing-api/)).toBeInTheDocument()
    expect([card.getByRole('button', { name: 'Reinstall on GitHub' }), card.getByText(/^Checked /)]).toHaveLength(2)
  })

  it('says what followed for the GitHub Issues source, and reads its view again (7.50.02)', async () => {
    renderPanel({ [CHECK]: () => ({
      repositories: ['example-org/billing-api'], missing: [],
      issues: { signs_in: 'app', added: ['example-org/billing-api'], reading: ['example-org/billing-api'],
        skipped: [{ repository: 'example-org/docs', reason: 'off' }],
        labels: [{ repository: 'example-org/billing-api', state: 'created' }, { repository: 'example-org/web', state: 'failed' }],
        schedule: 'on', error: null },
    }) })
    await chooseInRowMenu('Actions for voc-agents-3f9a2c', 'Check installation')
    expect(await screen.findByText(/The installation covers every connection of voc-agents-3f9a2c/)).toBeInTheDocument()
    const follow = within(await screen.findByTestId('issues-follow'))
    expect([follow.getByText('Issues: read automatically from 1 repository.'),
      follow.getByText('Label voc-agent: on example-org/billing-api.'),
      follow.getByText('The voc-agent label could not be created on example-org/web: Check installation tries again.'),
      follow.getByText('Not read (switched off): example-org/docs.')]).toHaveLength(4)
    await waitFor(() => {
      expect(fetchApi.mock.calls.filter(([path]) => path === '/agents/engineering/issues-source').length).toBeGreaterThan(1)
    })
  })

  it('checks every installed App on Check now, and none installed nowhere', async () => {
    const check = vi.fn(() => ({ repositories: ['example-org/billing-api'], missing: [] }))
    renderPanel({ [CHECK]: check })
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(check).toHaveBeenCalledTimes(1) })
    expect(fetchApi.mock.calls.filter(([path]) => path.endsWith('/check')).map(([path]) => path))
      .toStrictEqual(['/agents/engineering/github-apps/271828/check'])
  })

  it('says the server\'s 409 when connections still use the App it removes', async () => {
    const user = userEvent.setup()
    renderPanel({ 'DELETE /agents/engineering/github-apps/271828': () => { throw new ApiError(409, '1 connection(s) use this App: remove them first') } })
    await chooseInRowMenu('Actions for voc-agents-3f9a2c', 'Remove App…')
    await user.click(screen.getByRole('button', { name: 'Remove the App' }))
    expect(await screen.findByText('1 connection(s) use this App: remove them first')).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
  })
})
