/**
 * @fileoverview The deployment's GitHub Issues card's sign-in (7.45.00; App-first since 7.50.02, githubSignIn.ts).
 *
 * - While its connections manage the source (a stored App's id and `repos_managed`), the card says so, links to
 *   Agent orchestration → Connections and keeps its fields behind "Configure manually (advanced)".
 * - The manual path is App-first: with an App and nothing stored that decides otherwise it signs in with the App (the
 *   only one preselected and saved with the rest; a choice among several), the token behind "Use a fine-grained token
 *   instead". What is stored wins: an App's id is the App, `none` or repositories saved without an App the token.
 * - Without any App: the token, and Connect GitHub (Agent orchestration → Connections). Apps that cannot be listed leave the App's
 *   id typed by hand. Choosing the token saves `github_app_id` as `none` (the credentials route never deletes a value).
 * - Inside a workspace, and on any other card, the fields stay the manifest's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi } from '../../test/fetchApiRoutes'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import SourceCard from './SourceCard'
import type { PluginManifest } from '../../plugins/types'

const getIntegrationCredentials = vi.fn<(source: string, keys: string[]) => Promise<Record<string, string>>>()
const updateIntegrationCredentials = vi.fn<(source: string, credentials: Record<string, string>) => Promise<unknown>>()

vi.mock('../../api/client', async () => {
  const routed = await import('../../test/fetchApiRoutes')
  return {
    ...routed.fetchApiClientModule(),
    api: {
      getIntegrationStatus: () => Promise.resolve({}),
      getSourcesStatus: () => Promise.resolve({ sources: {} }),
      getIntegrationCredentials: (source: string, keys: string[]) => getIntegrationCredentials(source, keys),
      updateIntegrationCredentials: (source: string, credentials: Record<string, string>) => updateIntegrationCredentials(source, credentials),
    },
  }
})

const TOKEN_LABEL = 'Fine-grained token (read-only Issues + Metadata)'
const APP_ID_LABEL = 'GitHub App id (optional)'
const APP_INTRO = 'Signs in with your GitHub App: no token to paste. Issues and comments are read with short-lived, read-only tokens.'
const manifest = (id = 'github_issues'): PluginManifest => ({
  id, name: 'GitHub Issues', icon: 'GitHub', enabled: true, hasIngestor: true, hasWebhook: true, hasS3Trigger: false,
  config: [
    { key: 'repos', label: 'Repositories', type: 'textarea', required: true, secret: false },
    { key: 'token', label: TOKEN_LABEL, type: 'password', required: false, secret: true },
    { key: 'github_app_id', label: APP_ID_LABEL, type: 'text', required: false, secret: false },
  ],
})
const app = (appId: string, slug: string) => ({ app_id: appId, slug, owner: 'example-org', owner_type: 'Organization',
  html_url: `https://github.com/apps/${slug}`, webhook: true, connections: [], created_at: null, created_by: null, version: 1 })
const ONE_APP = { apps: [app('271828', 'voc-agents-3f9a2c')], limit: 5 }
const TWO_APPS = { apps: [app('271828', 'voc-agents-3f9a2c'), app('314159', 'voc-agents-b7e1d0')], limit: 5 }

async function openCard(plugin = manifest()) {
  const user = userEvent.setup()
  renderWithQueryClient(<TestRouter><SourceCard manifest={plugin} apiEndpoint="https://api.example.com" isAdmin /></TestRouter>)
  await user.click(screen.getByRole('button', { name: /GitHub Issues/ }))
  return user
}

const save = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: /save/i })) }
const saved = async (credentials: Record<string, string>) => {
  await waitFor(() => { expect(updateIntegrationCredentials).toHaveBeenCalledWith('github_issues', credentials) })
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ 'GET /agents/engineering/github-apps': () => ONE_APP })
  getIntegrationCredentials.mockReset().mockResolvedValue({})
  updateIntegrationCredentials.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => { setCurrentWorkspace(null) })

describe('the manual path, App-first', () => {
  it('signs in with the only App while nothing is stored, and saves its id with the repositories', async () => {
    const user = await openCard()
    expect(await screen.findByText('GitHub App: voc-agents-3f9a2c (example-org)')).toBeInTheDocument()
    expect([screen.queryByText(APP_INTRO) !== null, screen.queryByText(TOKEN_LABEL), screen.queryByText(APP_ID_LABEL)])
      .toStrictEqual([true, null, null])
    await user.type(screen.getByPlaceholderText('Enter repositories'), 'example-org/shop')
    await save(user)
    await saved({ github_app_id: '271828', repos: 'example-org/shop' })
    expect(getIntegrationCredentials).toHaveBeenCalledWith('github_issues', ['github_app_id', 'repos', 'repos_managed'])
  })

  it('hides the token behind its link, which reveals it and saves github_app_id as none', async () => {
    const user = await openCard()
    await user.click(await screen.findByRole('button', { name: 'Use a fine-grained token instead' }))
    expect(screen.getByText(TOKEN_LABEL)).toBeInTheDocument()
    expect(screen.queryByText(APP_INTRO)).not.toBeInTheDocument()
    await save(user)
    await saved({ github_app_id: 'none' })
  })

  it.each([
    ['github_app_id none', { github_app_id: 'none' }],
    ['repositories saved without an App', { repos: 'example-org/shop' }],
  ])('keeps a source saved with a token on the token (%s)', async (_case, stored) => {
    getIntegrationCredentials.mockResolvedValue(stored)
    await openCard()
    expect(await screen.findByText(TOKEN_LABEL)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with your GitHub App instead' })).toBeInTheDocument()
    expect(screen.queryByText(APP_INTRO)).not.toBeInTheDocument()
  })

  it('moves a token source back to the only App, which Save writes', async () => {
    getIntegrationCredentials.mockResolvedValue({ github_app_id: 'none' })
    const user = await openCard()
    await user.click(await screen.findByRole('button', { name: 'Sign in with your GitHub App instead' }))
    expect(screen.queryByText(TOKEN_LABEL)).not.toBeInTheDocument()
    await save(user)
    await saved({ github_app_id: '271828' })
  })

  it('starts on the stored App, with nothing to save until something changes', async () => {
    getIntegrationCredentials.mockResolvedValue({ github_app_id: '271828' })
    await openCard()
    expect(await screen.findByText(APP_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(TOKEN_LABEL)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('offers a choice among several Apps, and saves the one chosen', async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => TWO_APPS })
    const user = await openCard()
    const choice = await screen.findByLabelText(/GitHub App/)
    expect(choice).toHaveValue('')
    await user.selectOptions(choice, '314159')
    await save(user)
    await saved({ github_app_id: '314159' })
  })

  it('offers Connect GitHub (Agent orchestration → Connections) while the deployment has no App, the token in view', async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }) })
    await openCard()
    expect(await screen.findByRole('link', { name: 'Connect GitHub' })).toHaveAttribute('href', '/agents/connections')
    expect(screen.getByText(TOKEN_LABEL)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with your GitHub App instead' })).not.toBeInTheDocument()
  })

  it('takes the App\'s id as text when the Apps cannot be listed', async () => {
    routeFetchApi({}, { missStatus: 404 })
    const user = await openCard()
    await user.click(await screen.findByRole('button', { name: 'Sign in with your GitHub App instead' }))
    await waitFor(() => { expect(fetchApi.mock.calls.map(([path]) => path)).toContain('/agents/engineering/github-apps') })
    expect(await screen.findByText(APP_ID_LABEL)).toBeInTheDocument()
    expect(screen.queryByText(TOKEN_LABEL)).not.toBeInTheDocument()
  })
})

describe('a source its connections manage', () => {
  const MANAGED = { github_app_id: '271828', repos: 'example-org/shop\nexample-org/api', repos_managed: 'example-org/shop\nexample-org/api' }

  it('says so with the count and Agent orchestration → Connections, the fields behind Configure manually', async () => {
    getIntegrationCredentials.mockResolvedValue(MANAGED)
    const user = await openCard()
    const managed = await screen.findByTestId('github-issues-managed')
    expect(managed).toHaveTextContent('Managed by your GitHub connection: issues from 2 repositories.')
    expect(within(managed).getByRole('link', { name: 'Open Agent orchestration → Connections' })).toHaveAttribute('href', '/agents/connections')
    const manual = screen.getByText('Configure manually (advanced)')
    expect(screen.getByText(APP_INTRO)).not.toBeVisible()
    await user.click(manual)
    expect(screen.getByText(APP_INTRO)).toBeVisible()
  })

  it.each([
    ['without an App', { ...MANAGED, github_app_id: 'none' }],
    ['with none managed', { github_app_id: '271828', repos: 'example-org/shop' }],
  ])('is the manual card as it is %s', async (_case, stored) => {
    getIntegrationCredentials.mockResolvedValue(stored)
    await openCard()
    expect(await screen.findByRole('button', { name: /save/i })).toBeVisible()
    expect(screen.queryByTestId('github-issues-managed')).not.toBeInTheDocument()
  })
})

describe('where the choice is not offered', () => {
  it('keeps the manifest\'s fields inside a workspace, where a run ignores the App', async () => {
    setCurrentWorkspace({ id: 'ws_1', slug: 'team', name: 'Team', role: 'admin' })
    await openCard()
    expect([screen.getByText(TOKEN_LABEL), screen.getByText(APP_ID_LABEL)]).toHaveLength(2)
    expect(screen.queryByTestId('github-sign-in')).not.toBeInTheDocument()
    expect(getIntegrationCredentials).not.toHaveBeenCalled()
  })

  it('keeps every other card\'s fields as they are', async () => {
    await openCard(manifest('other_source'))
    expect(screen.queryByTestId('github-sign-in')).not.toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
