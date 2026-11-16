/**
 * @fileoverview The deployment's GitHub Issues card's "Sign in with" (7.45.00, githubSignIn.ts): a token, or one of the
 * deployment's GitHub Apps. The stored `github_app_id` decides where it starts (an App's id: the App); the App's field
 * is a select of the deployment's Apps when their list answers, else the plain text field; choosing the token saves
 * `github_app_id` as `none` (the credentials route never deletes a value), which the ingestor reads as no App. Inside
 * a workspace, and on any other card, the fields stay the manifest's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
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
const manifest = (id = 'github_issues'): PluginManifest => ({
  id, name: 'GitHub Issues', icon: 'GitHub', enabled: true, hasIngestor: true, hasWebhook: true, hasS3Trigger: false,
  config: [
    { key: 'repos', label: 'Repositories', type: 'textarea', required: true, secret: false },
    { key: 'token', label: TOKEN_LABEL, type: 'password', required: false, secret: true },
    { key: 'github_app_id', label: APP_ID_LABEL, type: 'text', required: false, secret: false },
  ],
})
const APPS = { apps: [{ app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: [], created_at: null, created_by: null,
  version: 1 }], limit: 5 }

async function openCard(plugin = manifest()) {
  const user = userEvent.setup()
  renderWithQueryClient(<SourceCard manifest={plugin} apiEndpoint="https://api.example.com" isAdmin />)
  await user.click(screen.getByRole('button', { name: /GitHub Issues/ }))
  return user
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ 'GET /agents/engineering/github-apps': () => APPS })
  getIntegrationCredentials.mockReset().mockResolvedValue({ github_app_id: 'none' })
  updateIntegrationCredentials.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => { setCurrentWorkspace(null) })

describe('the deployment\'s GitHub Issues card', () => {
  it('starts on the token while no App is stored, the App\'s field hidden', async () => {
    await openCard()
    expect(await screen.findByLabelText('Sign in with')).toHaveValue('token')
    expect(screen.getByText(TOKEN_LABEL)).toBeInTheDocument()
    expect(screen.queryByText(APP_ID_LABEL)).not.toBeInTheDocument()
  })

  it('starts on the App once one is stored', async () => {
    getIntegrationCredentials.mockResolvedValue({ github_app_id: '271828' })
    await openCard()
    await waitFor(() => { expect(screen.getByLabelText('Sign in with')).toHaveValue('app') })
    expect(screen.queryByText(TOKEN_LABEL)).not.toBeInTheDocument()
  })

  it('offers the deployment\'s Apps by name, and saves the one chosen', async () => {
    const user = await openCard()
    await user.selectOptions(await screen.findByLabelText('Sign in with'), 'app')
    const appSelect = await screen.findByRole('option', { name: 'voc-agents-3f9a2c (example-org)' })
    await user.selectOptions(appSelect.closest('select') ?? document.body, '271828')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => { expect(updateIntegrationCredentials).toHaveBeenCalledWith('github_issues', { github_app_id: '271828' }) })
  })

  it('saves github_app_id as none when the token is chosen again', async () => {
    getIntegrationCredentials.mockResolvedValue({ github_app_id: '271828' })
    const user = await openCard()
    await waitFor(() => { expect(screen.getByLabelText('Sign in with')).toHaveValue('app') })
    await user.selectOptions(screen.getByLabelText('Sign in with'), 'token')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => { expect(updateIntegrationCredentials).toHaveBeenCalledWith('github_issues', { github_app_id: 'none' }) })
  })

  it('takes the App\'s id as text when the Apps cannot be listed', async () => {
    routeFetchApi({}, { missStatus: 404 })
    const user = await openCard()
    await user.selectOptions(await screen.findByLabelText('Sign in with'), 'app')
    await waitFor(() => { expect(fetchApi.mock.calls.map(([path]) => path)).toContain('/agents/engineering/github-apps') })
    expect(screen.getByText(APP_ID_LABEL)).toBeInTheDocument()
  })
})

describe('where the choice is not offered', () => {
  it('keeps the manifest\'s fields inside a workspace, where a run ignores the App', async () => {
    setCurrentWorkspace({ id: 'ws_1', slug: 'team', name: 'Team', role: 'admin' })
    await openCard()
    expect([screen.getByText(TOKEN_LABEL), screen.getByText(APP_ID_LABEL)]).toHaveLength(2)
    expect(screen.queryByLabelText('Sign in with')).not.toBeInTheDocument()
    expect(getIntegrationCredentials).not.toHaveBeenCalled()
  })

  it('keeps every other card\'s fields as they are', async () => {
    await openCard(manifest('other_source'))
    expect(screen.queryByLabelText('Sign in with')).not.toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
