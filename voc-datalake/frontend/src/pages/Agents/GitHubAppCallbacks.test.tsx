/**
 * @fileoverview The two pages GitHub sends an administrator back to (7.45.00): GitHubAppCreated.tsx (the manifest's
 * code and state) and GitHubAppInstalled.tsx (the installation's id, its setup action and the state). Each takes its
 * query, removes it from the address at once with a replace (the code is a bearer credential for an hour), and sends
 * its one request exactly once, StrictMode's double effects included; without what it needs, or when GitHub says an
 * owner must approve the installation, it sends nothing. A refusal is said in the server's words.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import { createTestQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: GitHubAppCreated } = await import('./GitHubAppCreated')
const { default: GitHubAppInstalled } = await import('./GitHubAppInstalled')

const CREATED = '/agents/connections/github/created'
const INSTALLED = '/agents/connections/github/installed'
const CONVERSIONS = 'POST /agents/engineering/github-apps/conversions'
const INSTALLATIONS = 'POST /agents/engineering/github-apps/installations'
const APP = {
  app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: [], created_at: null,
  created_by: null, version: 1,
}
const INSTALL_URL = 'https://github.com/apps/voc-agents-3f9a2c/installations/new?state=s2'
const connection = (id: string, repository: string) => ({
  connection_id: id, host: 'github', repository, default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  version: 1, ci_attestation: null, repository_private: true,
})

/** The address the router holds, and how it got there (a replace keeps no history entry of the query). */
function Where() {
  const { search } = useLocation()
  return <output data-testid="where">{`${useNavigationType()} ${search}`}</output>
}

function renderAt(entry: string, routes: Record<string, RouteHandler>) {
  routeFetchApi(routes, { missStatus: 500 })
  render(
    <StrictMode>
      <QueryClientProvider client={createTestQueryClient()}>
        <TestRouter initialEntries={[entry]}>
          <Routes>
            <Route path={CREATED} element={<><GitHubAppCreated /><Where /></>} />
            <Route path={INSTALLED} element={<><GitHubAppInstalled /><Where /></>} />
          </Routes>
        </TestRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}

const posts = (endpoint: string) => fetchApi.mock.calls.filter(([path, options]) => path === endpoint && options?.method === 'POST')

beforeEach(() => { resetFetchApi() })

describe('the creation\'s return', () => {
  it('removes the code and the state from the address with a replace, and sends them once', async () => {
    renderAt(`${CREATED}?code=the-code&state=the-state`, { [CONVERSIONS]: () => ({ app: APP, install_url: INSTALL_URL }) })
    expect(await screen.findByText(/voc-agents-3f9a2c is created and its key stored/)).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(/^REPLACE$/)
    expect(posts('/agents/engineering/github-apps/conversions')).toHaveLength(1)
    expect(sentFetchApiBody('/agents/engineering/github-apps/conversions', 'POST')).toStrictEqual({ code: 'the-code', state: 'the-state' })
  })

  it('offers the App\'s installation as a plain link to github.com', async () => {
    renderAt(`${CREATED}?code=c&state=s`, { [CONVERSIONS]: () => ({ app: APP, install_url: INSTALL_URL }) })
    expect(await screen.findByRole('link', { name: 'Install on GitHub' })).toHaveAttribute('href', INSTALL_URL)
  })

  it('sends nothing without a code or a state', async () => {
    renderAt(`${CREATED}?state=only-a-state`, {})
    expect(await screen.findByText(/needs the link GitHub sends back/)).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('says the server\'s refusal of an expired code in its words', async () => {
    renderAt(`${CREATED}?code=c&state=s`, {
      [CONVERSIONS]: () => { throw new ApiError(409, 'GitHub refused the code: delete the App in GitHub and start again') },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub refused the code: delete the App in GitHub and start again')
  })
})

describe('the installation\'s return', () => {
  const answer = () => ({
    app: APP, account: { login: 'example-org', type: 'Organization' },
    connections: [{ connection: connection('payments', 'example-org/payments'), created: true },
      { connection: connection('billing', 'example-org/billing'), created: true }],
    skipped: [{ repository: 'example-org/old-site', reason: 'archived' }],
  })

  it('removes the query with a replace, sends the installation once and says what it connected', async () => {
    renderAt(`${INSTALLED}?installation_id=31415926&setup_action=install&state=s2`, { [INSTALLATIONS]: answer })
    expect(await screen.findByText('Connected 2 repositories through voc-agents-3f9a2c.')).toBeInTheDocument()
    expect([screen.getByText('Before the agents push, confirm each repository\'s CI.'),
      screen.getByText('example-org/old-site: archived')]).toHaveLength(2)
    expect(screen.getByTestId('where')).toHaveTextContent(/^REPLACE$/)
    expect(sentFetchApiBody('/agents/engineering/github-apps/installations', 'POST'))
      .toStrictEqual({ installation_id: 31415926, setup_action: 'install', state: 's2' })
  })

  it('sends it once only, whatever StrictMode runs twice', async () => {
    renderAt(`${INSTALLED}?installation_id=31415926&setup_action=update&state=s2`, { [INSTALLATIONS]: answer })
    await screen.findByText('Connected 2 repositories through voc-agents-3f9a2c.')
    expect(posts('/agents/engineering/github-apps/installations')).toHaveLength(1)
  })

  it('sends nothing when an owner must approve the installation', async () => {
    renderAt(`${INSTALLED}?setup_action=request&state=s2`, {})
    expect(await screen.findByText(/An owner must approve the installation/)).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('sends nothing for a return without this deployment\'s state, and points to Check installation', async () => {
    renderAt(`${INSTALLED}?installation_id=31415926&setup_action=update`, {})
    expect(await screen.findByText(/use Check installation or Install more/)).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
