/**
 * @fileoverview The GitHub Apps client (api/githubAppsApi.ts, 7.45.00): each call's path and body, and the
 * normalisers — an App the page cannot read is dropped, an answer without its list is an error (never "no Apps"), an
 * address off github.com is never followed (an unreadable answer, or no link), and an installation's connections
 * and skipped repositories are read one by one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { githubAppsApi } = await import('./githubAppsApi')

const APP = {
  app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: ['billing-api'],
  created_at: '2026-11-10T10:00:00Z', created_by: 'admin-a', version: 1,
}
const CONNECTION = {
  connection_id: 'payments', host: 'github', repository: 'example-org/payments', default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: null,
  repository_private: true,
}
const INSTALL_URL = 'https://github.com/apps/voc-agents-3f9a2c/installations/new?state=s2'

beforeEach(() => { resetFetchApi() })

describe('the list', () => {
  it('keeps each App it can read, with its limit', async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({ apps: [APP, { slug: 'no-id' }], limit: 5 }) })
    const list = await githubAppsApi.list()
    expect(list.apps.map((app) => app.slug)).toStrictEqual(['voc-agents-3f9a2c'])
    expect(list.limit).toBe(5)
  })

  it('reads an answer without a list as an error, never as no Apps', async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({ items: [] }) })
    await expect(githubAppsApi.list()).rejects.toThrow('The GitHub Apps answer was unreadable')
  })

  it('links no App page off github.com, and reads an unknown account type as a person\'s', async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({
      apps: [{ ...APP, html_url: 'javascript:alert(1)', owner_type: 'Enterprise' }],
    }) })
    const [app] = (await githubAppsApi.list()).apps
    expect([app?.html_url, app?.owner_type]).toStrictEqual(['', 'User'])
  })

  it("is read in the scope asked for: the current workspace's by default, the deployment's for Data sources", async () => {
    routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({ apps: [APP], limit: 5 }) })
    await githubAppsApi.list()
    await githubAppsApi.listIn('deployment')
    expect(fetchApi.mock.calls.map((call) => call[2])).toStrictEqual(['workspace', 'deployment'])
  })
})

describe('the manifest form', () => {
  it('sends the account and answers the server\'s form as it is', async () => {
    const manifest = { name: 'VoC Autonomous Agent 3f9a', public: false }
    routeFetchApi({ 'POST /agents/engineering/github-apps/manifest': () => ({
      action_url: 'https://github.com/organizations/example-org/settings/apps/new?state=s1', manifest, expires_at: 'later',
    }) })
    const form = await githubAppsApi.manifest({ account: 'organization', org: 'example-org' })
    expect(sentFetchApiBody('/agents/engineering/github-apps/manifest', 'POST')).toStrictEqual({ account: 'organization', org: 'example-org' })
    expect(form).toStrictEqual({
      actionUrl: 'https://github.com/organizations/example-org/settings/apps/new?state=s1', manifest, expiresAt: 'later',
    })
  })

  it('never posts a manifest anywhere but github.com', async () => {
    routeFetchApi({ 'POST /agents/engineering/github-apps/manifest': () => ({
      action_url: 'https://example.com/settings/apps/new', manifest: {}, expires_at: 'later',
    }) })
    await expect(githubAppsApi.manifest({ account: 'user' })).rejects.toThrow('The GitHub App manifest answer was unreadable')
  })
})

describe('the creation and the installation', () => {
  it('exchanges the code with its state and answers the App and its install link', async () => {
    routeFetchApi({ 'POST /agents/engineering/github-apps/conversions': () => ({ app: APP, install_url: INSTALL_URL, expires_at: 'later' }) })
    const created = await githubAppsApi.convert('the-code', 'the-state')
    expect(sentFetchApiBody('/agents/engineering/github-apps/conversions', 'POST')).toStrictEqual({ code: 'the-code', state: 'the-state' })
    expect([created.app.slug, created.installUrl]).toStrictEqual(['voc-agents-3f9a2c', INSTALL_URL])
  })

  it('refuses an install link off github.com', async () => {
    routeFetchApi({ 'POST /agents/engineering/github-apps/271828/install': () => ({ install_url: 'https://github.com.evil.example/x' }) })
    await expect(githubAppsApi.install('271828')).rejects.toThrow('The install link answer was unreadable')
  })

  it('sends the installation\'s return and reads each saved connection and skipped repository', async () => {
    routeFetchApi({ 'POST /agents/engineering/github-apps/installations': () => ({
      app: APP, account: { login: 'example-org', type: 'Organization' },
      connections: [{ connection: CONNECTION, created: true }, { connection: { connection_id: '' }, created: true }],
      skipped: [{ repository: 'example-org/old-site', reason: 'archived' }, { repository: 'example-org/x', reason: 'new' }],
    }) })
    const installation = await githubAppsApi.installed({ installationId: 31415926, setupAction: 'install', state: 's2' })
    expect(sentFetchApiBody('/agents/engineering/github-apps/installations', 'POST'))
      .toStrictEqual({ installation_id: 31415926, setup_action: 'install', state: 's2' })
    expect(installation.connections.map(({ connection }) => connection.credential.kind)).toStrictEqual(['app_reference'])
    expect(installation.skipped).toStrictEqual([
      { repository: 'example-org/old-site', reason: 'archived' }, { repository: 'example-org/x', reason: 'not_saved' },
    ])
  })
})

describe('the check and the removal', () => {
  it('answers the installed repositories and the connections no longer covered', async () => {
    routeFetchApi({ 'POST /agents/engineering/github-apps/271828/check': () => ({ repositories: ['example-org/payments', 3], missing: ['billing-api'] }) })
    await expect(githubAppsApi.check('271828')).resolves.toStrictEqual({ repositories: ['example-org/payments'], missing: ['billing-api'] })
  })

  it('removes the App with the reason only when one is given', async () => {
    routeFetchApi({ 'DELETE /agents/engineering/github-apps/271828': () => ({ removed: true }) })
    await githubAppsApi.remove('271828', '  ')
    await githubAppsApi.remove('271828', 'replaced')
    expect(fetchApi.mock.calls.map(([, options]) => options?.body)).toStrictEqual(['{}', '{"reason":"replaced"}'])
  })
})
