/**
 * Administration → Data sources (7.54.00, DataSourcesPage.tsx): one page, This workspace | Deployment.
 *
 * The real API client runs against a stubbed `fetch`, so these specs read the request headers themselves. In the
 * deployment's scope (`?scope=deployment`, a platform admin's, inside a workspace) no request of the page carries
 * `X-Workspace-Id` (the credentials' status, read and save, the schedules and their pauses, a reset, the GitHub Issues
 * card's App sign-in and the Apps it lists), and the two-sentence notice says what these sources feed;
 * `/admin/sources/github_issues?scope=deployment` opens the GitHub Issues card, scrolled into view. In this workspace's
 * scope every request but the deployment-only schedule switch names the workspace, and the card offers no App sign-in.
 * The cards come health first; Email inbox, Radar and the Design-system tokens sit in the Advanced fold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
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
vi.mock('./EmailInboxCard', () => ({ default: () => <p>Email inbox card</p> }))
vi.mock('./RadarSection', () => ({ default: () => <p>Radar card</p> }))
vi.mock('./IntegrationsSection', () => ({ default: () => <p>Design-system tokens card</p> }))

const ISSUES = 'github_issues'
const issuesManifest: PluginManifest = {
  id: ISSUES, name: 'GitHub Issues', icon: 'GitHub', enabled: true, hasIngestor: true, hasWebhook: true, hasS3Trigger: false,
  config: [
    { key: 'repos', label: 'Repositories', type: 'textarea', required: true, secret: false },
    { key: 'token', label: 'Fine-grained token (read-only Issues + Metadata)', type: 'password', required: false, secret: true },
    { key: 'github_app_id', label: 'GitHub App id (optional)', type: 'text', required: false, secret: false },
  ],
}
const scraperManifest: PluginManifest = {
  id: 'webscraper', name: 'Web scraper', icon: 'Web', enabled: true, hasIngestor: true, hasWebhook: false, hasS3Trigger: false, config: [],
}
const plugins = { list: [issuesManifest] }
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => plugins.list }))

import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import DataSourcesPage from './DataSourcesPage'

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
afterEach(() => {
  setCurrentWorkspace(null)
  plugins.list = [issuesManifest]
})

/** Data sources at `path` for a platform admin (`isPlatformAdmin` false: a plain administrator). */
const renderPage = (path: string, isPlatformAdmin = true) => renderWithQueryClient(
  <TestRouter initialEntries={[path]}>
    <DataSourcesPage apiEndpoint={`${API}/`} isAdmin isPlatformAdmin={isPlatformAdmin} section={null} />
  </TestRouter>)

/** The deployment's sources (`?scope=deployment`). */
const renderDeployment = (path = '/admin/sources') => renderPage(`${path}?scope=deployment`)

/** Reset the card's pause, open it and save its credentials (on the deployment's card, choosing the token back). */
async function useTheCard(withAppSignIn: boolean) {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Reset' }))
  await user.click(screen.getByRole('button', { name: /GitHub Issues/ }))
  if (withAppSignIn) {
    await user.click(await screen.findByRole('button', { name: 'Use a fine-grained token instead' }))
  } else {
    await user.type(screen.getByPlaceholderText('Enter repositories'), 'example-org/shop')
  }
  await user.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => { expect(sent().map((s) => s.request)).toContain(`PUT /integrations/${ISSUES}/credentials`) })
}

describe("the deployment's Data sources", () => {
  it('sends no X-Workspace-Id on any request inside a workspace, the App sign-in included', async () => {
    renderDeployment()
    await useTheCard(true)

    expect(new Set(sent().map((s) => s.request))).toStrictEqual(new Set([
      'GET /integrations/status', 'GET /sources/status', `POST /sources/${ISSUES}/reset`,
      `GET /integrations/${ISSUES}/credentials`, 'GET /agents/engineering/github-apps', `PUT /integrations/${ISSUES}/credentials`,
    ]))
    expect(sent().filter((s) => s.workspace !== undefined)).toStrictEqual([])
  })

  it('says in two sentences what its sources feed and who reads it, and offers the switch back', async () => {
    renderDeployment()
    expect(screen.getByRole('note')).toHaveTextContent(
      'These sources bring in deployment-wide feedback, outside every workspace. It is the only feedback the engineering automations read.')
    expect(screen.getByRole('radio', { name: 'Deployment' })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByRole('button', { name: /GitHub Issues/ })).toBeInTheDocument()
  })

  it('folds no Advanced cards into the deployment\'s view', () => {
    renderDeployment()
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument()
  })

  it('opens the GitHub Issues card from /admin/sources/github_issues?scope=deployment, scrolled into view', async () => {
    const restore = stubElementScrollIntoView()
    try {
      renderDeployment(`/admin/sources/${ISSUES}`)
      expect(screen.getByRole('button', { name: /GitHub Issues/ })).toHaveAttribute('aria-expanded', 'true')
      expect(await screen.findByText(/Signs in with your GitHub App/)).toBeInTheDocument()
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('keeps the card closed on the page\'s own address', () => {
    renderDeployment()
    expect(screen.getByRole('button', { name: /GitHub Issues/ })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe("this workspace's sources (the page's default)", () => {
  it('still names the workspace on every request but the schedule switch, and offers no App sign-in', async () => {
    renderPage('/admin/sources')
    await useTheCard(false)

    expect(screen.queryByTestId('github-sign-in')).not.toBeInTheDocument()
    const requests = sent().filter((s) => !DEPLOYMENT_ONLY.has(s.request))
    expect(requests.map((s) => s.request)).not.toContain('GET /agents/engineering/github-apps')
    expect(requests.length).toBeGreaterThan(2)
    expect(requests.filter((s) => s.workspace !== ACME.id)).toStrictEqual([])
  })

  it('switches to the deployment as a radio group (This workspace checked), with no notice yet', async () => {
    renderPage('/admin/sources')
    const user = userEvent.setup()
    expect([screen.getByRole('radio', { name: 'This workspace' }).getAttribute('aria-checked'), screen.queryByRole('note')])
      .toStrictEqual(['true', null])
    await user.click(screen.getByRole('radio', { name: 'Deployment' }))
    expect(await screen.findByRole('note')).toHaveTextContent('deployment-wide feedback')
  })

  it('offers no switch to a plain administrator', () => {
    renderPage('/admin/sources', false)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('offers no switch outside a workspace, where the page is the deployment\'s', () => {
    act(() => setCurrentWorkspace(null))
    renderPage('/admin/sources')
    expect([screen.queryByRole('radiogroup'), screen.getByRole('note')]).toStrictEqual([null, expect.anything()])
  })

  it('puts a paused source on top (health first)', async () => {
    plugins.list = [scraperManifest, issuesManifest]
    renderPage('/admin/sources')
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /GitHub Issues|Web Scraper/ }).map((b) => b.textContent))
        .toStrictEqual([expect.stringContaining('GitHub Issues'), expect.stringContaining('Web Scraper')])
    })
  })

  it('folds Email inbox, Radar and the Design-system tokens under Advanced', async () => {
    renderPage('/admin/sources')
    const user = userEvent.setup()
    expect(screen.queryByText('Radar card')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect([screen.getByText('Email inbox card'), screen.getByText('Radar card'), screen.getByText('Design-system tokens card')])
      .toHaveLength(3)
  })
})
