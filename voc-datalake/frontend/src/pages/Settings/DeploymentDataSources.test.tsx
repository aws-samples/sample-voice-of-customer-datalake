/**
 * Administration → Data sources (7.50.00, DeploymentDataSources.tsx): the deployment's own sources from any address.
 * The real API client runs against a stubbed `fetch`, so these specs read the request headers themselves. Inside a
 * workspace no request of the page carries `X-Workspace-Id` (the credentials' status, read and save, the schedules and
 * their pauses, a reset, the GitHub Issues card's App sign-in and the Apps it lists), and the page says what these
 * sources feed and who reads it; the workspace's own Data sources page (Sources → Source settings) still names the
 * workspace on every request but the deployment-only schedule switch, and offers no App sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { ACME } from '@test/workspaceFixtures'
import { fetchMock, installFetchMock, requestHeaders, requestUrl } from '@test/fetch-mock'
import type { PluginManifest } from '../../plugins/types'

const API = 'https://api.example.com'
vi.mock('../../store/configStore', () => import('@test/api-mocks').then((m) => m.configStoreMock('https://api.example.com')))
vi.mock('../../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtimeConfig')>(),
  ...(await import('@test/api-mocks')).runtimeConfigMock('https://api.example.com'),
}))
vi.mock('../../services/auth', () => import('@test/api-mocks').then((m) => m.authServiceMock()))
vi.mock('../../components/S3ImportExplorer/S3ImportExplorer', () => ({ default: () => null }))

const ISSUES = 'github_issues'
const issuesManifest: PluginManifest = {
  id: ISSUES, name: 'GitHub Issues', icon: 'GitHub', enabled: true, hasIngestor: true, hasWebhook: true, hasS3Trigger: false,
  config: [
    { key: 'repos', label: 'Repositories', type: 'textarea', required: true, secret: false },
    { key: 'token', label: 'Fine-grained token (read-only Issues + Metadata)', type: 'password', required: false, secret: true },
    { key: 'github_app_id', label: 'GitHub App id (optional)', type: 'text', required: false, secret: false },
  ],
}
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [issuesManifest] }))

import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import DeploymentDataSources from './DeploymentDataSources'
import { DataSourcesSection } from './SettingsSections'

const TRIPPED = { tripped: true, tripped_at: '2026-11-16T09:00:00Z', failure_count: 5, last_error: 'HTTPError: 429' }
const CLOSED = { tripped: false, tripped_at: null, failure_count: 0, last_error: null }
const APPS = { apps: [{ app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: [], created_at: null, created_by: null,
  version: 1 }], limit: 5 }
/** What the stubbed API answers, by `<METHOD> <path>` (the query left out). */
const ANSWERS: Readonly<Record<string, unknown>> = {
  'GET /integrations/status': { [ISSUES]: { configured: true, credentials_set: ['repos'] } },
  'GET /sources/status': { sources: { [ISSUES]: { enabled: true, exists: true, circuit: TRIPPED } } },
  [`GET /integrations/${ISSUES}/credentials`]: { github_app_id: '271828' },
  [`PUT /integrations/${ISSUES}/credentials`]: { success: true, message: 'Saved' },
  [`POST /sources/${ISSUES}/reset`]: { success: true, source: ISSUES, enabled: true, circuit: CLOSED },
  'GET /agents/engineering/github-apps': APPS,
}
/** The schedule switch is the deployment's wherever it is pressed (api/client.ts enableSource, disableSource). */
const DEPLOYMENT_ONLY = new Set([`PUT /sources/${ISSUES}/enable`, `PUT /sources/${ISSUES}/disable`])

interface Sent { readonly request: string; readonly workspace: string | undefined }

/** A request's method, as `fetch` was given it (`GET` when the init names none). */
function methodOf(init: unknown): string {
  return typeof init === 'object' && init !== null && 'method' in init && typeof init.method === 'string' ? init.method : 'GET'
}

/** Every request the page sent: `<METHOD> <path>` and the `X-Workspace-Id` it carried. */
function sent(): Sent[] {
  return fetchMock().mock.calls.map((call: unknown[], index) => ({
    request: `${methodOf(call[1])} ${new URL(requestUrl(index)).pathname}`,
    workspace: requestHeaders(index)['X-Workspace-Id'],
  }))
}

beforeEach(() => {
  installFetchMock().mockImplementation((url: string, init: unknown) => {
    const key = `${methodOf(init)} ${new URL(url).pathname}`
    return Promise.resolve(key in ANSWERS
      ? { ok: true, status: 200, json: () => Promise.resolve(ANSWERS[key]) }
      : { ok: false, status: 404, text: () => Promise.resolve('{"error":"Not found"}') })
  })
  act(() => setCurrentWorkspace(ACME))
})
afterEach(() => { setCurrentWorkspace(null) })

/** Reset the card's pause, open it and save its credentials (on the deployment's card, choosing the token back). */
async function useTheCard(withAppSignIn: boolean) {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Reset' }))
  await user.click(screen.getByRole('button', { name: /GitHub Issues/ }))
  if (withAppSignIn) {
    await waitFor(() => { expect(screen.getByLabelText('Sign in with')).toHaveValue('app') })
    await user.selectOptions(screen.getByLabelText('Sign in with'), 'token')
  } else {
    await user.type(screen.getByPlaceholderText('Enter repositories'), 'example-org/shop')
  }
  await user.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => { expect(sent().map((s) => s.request)).toContain(`PUT /integrations/${ISSUES}/credentials`) })
}

describe("the deployment's Data sources", () => {
  it('sends no X-Workspace-Id on any request inside a workspace, the App sign-in included', async () => {
    renderWithQueryClient(<DeploymentDataSources apiEndpoint={`${API}/`} isAdmin />)
    await useTheCard(true)

    expect(new Set(sent().map((s) => s.request))).toStrictEqual(new Set([
      'GET /integrations/status', 'GET /sources/status', `POST /sources/${ISSUES}/reset`,
      `GET /integrations/${ISSUES}/credentials`, 'GET /agents/engineering/github-apps', `PUT /integrations/${ISSUES}/credentials`,
    ]))
    expect(sent().filter((s) => s.workspace !== undefined)).toStrictEqual([])
  })

  it('says what its sources feed and who reads it, and that the workspace the app is in is not changed', async () => {
    renderWithQueryClient(<DeploymentDataSources apiEndpoint={`${API}/`} isAdmin />)
    const notice = screen.getByTestId('deployment-sources-notice')
    const text = notice.textContent
    expect([
      text.includes('the feedback they bring in is deployment-wide, outside every workspace'),
      /only feedback the engineering automations read \(Bug fixer, Feature builder, Issue triage\)/.test(text),
      text.includes("with the deployment's GitHub App"),
    ]).toStrictEqual([true, true, true])
    expect(within(notice).getByRole('note')).toHaveTextContent(`You are in ${ACME.name}, but nothing on this page changes it`)
    expect(await screen.findByRole('button', { name: /GitHub Issues/ })).toBeInTheDocument()
  })

  it('leaves the workspace line out outside a workspace', () => {
    act(() => setCurrentWorkspace(null))
    renderWithQueryClient(<DeploymentDataSources apiEndpoint={`${API}/`} isAdmin />)
    expect(within(screen.getByTestId('deployment-sources-notice')).queryByRole('note')).not.toBeInTheDocument()
  })
})

describe("a workspace's own Data sources, beside it", () => {
  it('still names the workspace on every request but the schedule switch, and offers no App sign-in', async () => {
    renderWithQueryClient(<DataSourcesSection apiEndpoint={`${API}/`} isAdmin />)
    await useTheCard(false)

    expect(screen.queryByLabelText('Sign in with')).not.toBeInTheDocument()
    const requests = sent().filter((s) => !DEPLOYMENT_ONLY.has(s.request))
    expect(requests.map((s) => s.request)).not.toContain('GET /agents/engineering/github-apps')
    expect(requests.length).toBeGreaterThan(2)
    expect(requests.filter((s) => s.workspace !== ACME.id)).toStrictEqual([])
  })
})
