/**
 * @fileoverview Any public GitHub repository on Agents → Connections (7.57.00): Add a public repository searches GitHub
 * on the server and shows each result's stars, licence, Archived badge and last push, with Connect read-only (the POST
 * with the repository; one already connected says so); a public repository read only is a row of its own card (its
 * badge, the "stays in VoC" note, no CI to attest) with the guided Contribute to ‹upstream›: three steps whose statuses
 * follow the connections and the person's authorizations (fork it on GitHub's own fork page, in a new tab; let the
 * agents push to the fork, whose dialog needs the licence ticked before it asks the server and then goes to the App's
 * install page; optionally Authorize as me), and a summary with the real names; an archived repository or one with no
 * licence holds step 2; a fork's row says its upstream, its owner and its runs' one-click outcome, and only the owner
 * turns its upstream pull request switch; the person's authorization of an App, and an older App's OAuth client form
 * (the secret sent, never shown back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { stubLocationAssign } from '@test/location'
import { appConnection, githubApp } from '@test/githubAppFixtures'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const LIST = 'GET /agents/engineering/connections'
const APPS = 'GET /agents/engineering/github-apps'
const SEARCH = 'GET /agents/engineering/public-repositories?q=lint'
const CONNECT = 'POST /agents/engineering/public-connections'
const FORK = 'POST /agents/engineering/connections/lint-kit/fork'
const AUTHORIZATIONS = 'GET /agents/engineering/github-apps/authorizations'

const result = (repository: string, fields: Record<string, unknown> = {}) => ({
  repository, description: 'A small, fast linter.', stars: 1240, licence: { spdx: 'MIT', name: 'MIT License' },
  archived: false, pushed_at: '2026-11-17T10:00:00Z', default_branch: 'main', html_url: `https://github.com/${repository}`,
  fork: false, connected: null, ...fields,
})

const publicRead = (fields: Record<string, unknown> = {}) => ({
  ...appConnection('lint-kit', 'open-tools/lint-kit'), repository_private: false, kind: 'public_read',
  credential: { kind: 'public_read', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  public: { stars: 1240, licence: 'MIT', archived: false, pushed_at: '2026-11-17T10:00:00Z' }, fork: null, ...fields,
})

const forkOf = (fork: Record<string, unknown> = {}) => ({
  ...appConnection('lint-kit-fork', 'alice/lint-kit'), repository_private: false, kind: 'fork',
  fork: { upstream: 'open-tools/lint-kit', upstream_connection: 'lint-kit', upstream_default_branch: 'main', owner: 'alice',
    owned_by_me: true, licence: 'MIT', upstream_pr_assisted: false, account: 'alice', account_type: 'User', ...fork },
})

function renderConnections(routes: Record<string, RouteHandler> = {}, connections: unknown[] = [], apps: unknown[] = [githubApp()]) {
  routeFetchApi({ [LIST]: () => ({ connections, limit: 20 }), [APPS]: () => ({ apps, limit: 5 }), ...routes }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, createTestQueryClient())
}

async function search(text = 'lint') {
  const picker = within(await screen.findByRole('region', { name: 'Add a public repository' }))
  await userEvent.type(picker.getByLabelText('Repository'), text)
  await userEvent.click(picker.getByRole('button', { name: 'Search' }))
  return picker
}

beforeEach(() => { resetFetchApi() })

describe('Add a public repository', () => {
  it('searches on the server and shows each result\'s stars, licence, archived state and last push', async () => {
    renderConnections({ [SEARCH]: () => ({ repositories: [result('open-tools/lint-kit'),
      result('open-tools/old-cli', { archived: true, licence: null, stars: 1 })], query: 'lint' }) })
    await search()
    const found = within(await screen.findByRole('list', { name: 'Public repositories found' }))
    const kit = within(found.getByTestId('public-result-open-tools/lint-kit'))
    expect([kit.getByText('1,240 stars'), kit.getByText('Licence MIT'), kit.getByText(/^Last push/)]).toHaveLength(3)
    expect(kit.queryByText('Archived')).toBeNull()
    const old = within(found.getByTestId('public-result-open-tools/old-cli'))
    expect([old.getByText('Archived'), old.getByText('No licence'), old.getByText('1 star')]).toHaveLength(3)
    expect(kit.getByRole('link', { name: /open-tools\/lint-kit/ })).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('connects a result read-only with its repository, and says so', async () => {
    renderConnections({
      [SEARCH]: () => ({ repositories: [result('open-tools/lint-kit')], query: 'lint' }),
      [CONNECT]: () => ({ connection: publicRead(), created: true, issues: null }),
    })
    await search()
    await userEvent.click(await screen.findByRole('button', { name: 'Connect read-only open-tools/lint-kit' }))
    await waitFor(() => { expect(sentFetchApiBody('/agents/engineering/public-connections', 'POST')).toStrictEqual({ repository: 'open-tools/lint-kit' }) })
    expect(await screen.findByText('open-tools/lint-kit is connected read-only.')).toBeInTheDocument()
  })

  it('offers no Connect for a repository already connected, and says a refusal in the server\'s words', async () => {
    renderConnections({
      [SEARCH]: () => ({ repositories: [result('open-tools/lint-kit', { connected: 'lint-kit' }), result('sample-labs/notes')],
        query: 'lint' }),
      [CONNECT]: () => { throw new ApiError(404, 'sample-labs/notes is not a public repository GitHub has') },
    })
    await search()
    const kit = within(await screen.findByTestId('public-result-open-tools/lint-kit'))
    expect([kit.getByText('Connected'), kit.queryByRole('button')]).toStrictEqual([kit.getByText('Connected'), null])
    await userEvent.click(screen.getByRole('button', { name: 'Connect read-only sample-labs/notes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('sample-labs/notes is not a public repository GitHub has')
  })

  it('says why nothing can be searched while the deployment has no App installation to read with', async () => {
    renderConnections({ [SEARCH]: () => { throw new ApiError(409, 'Connect GitHub first: public repositories are read with your GitHub App') } })
    await search()
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect GitHub first')
  })

  it('is not offered before the deployment has a GitHub App', async () => {
    renderConnections({}, [], [])
    await screen.findByRole('region', { name: 'Connect GitHub' })
    expect(screen.queryByRole('region', { name: 'Add a public repository' })).toBeNull()
  })
})

describe('a public repository read only', () => {
  it('is a row of its own card: its badge, what stays in VoC, and no CI to attest', async () => {
    renderConnections({}, [publicRead()])
    const row = within(await screen.findByTestId('public-row-lint-kit'))
    expect([row.getByText('Read-only (public)'), row.getByText(/stay in VoC: nothing is written to GitHub/)]).toHaveLength(2)
    expect([row.queryByText('CI not attested'), row.queryByRole('button', { name: /Attest CI/ })]).toStrictEqual([null, null])
    expect(screen.getByTestId('connections-status')).toHaveTextContent('1 public repository read only')
    expect(screen.getByTestId('connections-status')).not.toHaveTextContent('CI attested')
  })

  it.each([
    ['no licence', { stars: 3, licence: null, archived: false, pushed_at: null },
      'No licence: the repository can\'t be contributed to through the platform.'],
    ['archived', { stars: 3, licence: 'MIT', archived: true, pushed_at: null }, 'Archived: the repository takes no contributions.'],
  ])('holds step 2 of contributing to a repository with %s, and says why', async (_, facts, why) => {
    renderConnections({}, [publicRead({ public: facts })])
    const card = within(await screen.findByTestId('contribute-card-lint-kit'))
    expect(card.getByRole('status')).toHaveTextContent(why)
    const button = card.getByRole('button', { name: 'Install the App on your fork' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(why)
    await userEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Contribute to ‹upstream›, the guided setup', () => {
  const links = { fork_url: 'https://github.com/open-tools/lint-kit/fork',
    install_url: 'https://github.com/apps/voc-agents-3f9a2c/installations/new?state=f1', expires_at: 'later', app_id: '271828' }
  const OAUTH_APP = githubApp({ oauth: true, client_id: 'Iv23li', connections: ['lint-kit-fork'] })

  const CARD = { name: 'Contribute to open-tools/lint-kit' }

  async function cardOf() {
    return within(await screen.findByRole('region', CARD))
  }

  /** The card's steps' titles and statuses, in order. */
  function statuses() {
    const card = within(screen.getByRole('region', CARD))
    return [1, 2, 3].map((n) => {
      const step = within(card.getByTestId(`contribute-step-${n}`))
      return [step.getByText(/^\d\. /).textContent, step.getByText(/^(Done|To do|Optional)$/).textContent]
    })
  }

  async function openStep2() {
    await userEvent.click((await cardOf()).getByRole('button', { name: 'Install the App on your fork' }))
    return within(screen.getByRole('dialog', { name: 'Contribute to open-tools/lint-kit' }))
  }

  it('starts with the fork to make on GitHub\'s own fork page, in a new tab, and says whose is what', async () => {
    renderConnections({}, [publicRead()])
    const card = await cardOf()
    expect(card.getByText('The upstream is open-tools\'s; the fork and its pull requests are yours.')).toBeInTheDocument()
    expect(statuses()).toStrictEqual([['1. Fork it on GitHub', 'To do'], ['2. Let the agents push to your fork', 'To do'],
      ['3. Optional: open pull requests for you', 'Optional']])
    const forkLink = card.getByRole('link', { name: 'Fork on GitHub (opens in a new tab)' })
    expect([forkLink.getAttribute('href'), forkLink.getAttribute('target'), forkLink.getAttribute('rel')])
      .toStrictEqual(['https://github.com/open-tools/lint-kit/fork', '_blank', 'noopener noreferrer'])
    expect([...card.getByTestId('contribute-summary').querySelectorAll('li')].map((line) => line.textContent)).toStrictEqual([
      'Reads: open-tools/lint-kit (public, read-only).',
      'Agents push to: your fork, once it is connected.',
      'Pull requests to open-tools/lint-kit come from your fork (you click Create, or the app opens it for you once authorized).',
    ])
  })

  it('marks steps 1 and 2 done once the fork is connected, and names the fork and its account', async () => {
    renderConnections({}, [publicRead(), forkOf({ account: 'my-org', account_type: 'Organization' })])
    const card = await cardOf()
    expect(statuses().map(([, status]) => status)).toStrictEqual(['Done', 'Done', 'Optional'])
    expect([card.queryByRole('link', { name: /Fork on GitHub/ }), card.queryByRole('button', { name: 'Install the App on your fork' })])
      .toStrictEqual([null, null])
    expect([...card.getByTestId('contribute-summary').querySelectorAll('li')].map((line) => line.textContent)).toStrictEqual([
      'Reads: open-tools/lint-kit (public, read-only).',
      'Agents push to: alice/lint-kit (your fork).',
      'Pull requests to open-tools/lint-kit come from: my-org (you click Create, or the app opens it for you once authorized).',
    ])
  })

  it('finds the fork by its upstream\'s name too (its public connection made again)', async () => {
    renderConnections({}, [publicRead(), forkOf({ upstream: 'Open-Tools/Lint-Kit', upstream_connection: 'an-older-one' })])
    await cardOf()
    expect(statuses().map(([, status]) => status)).toStrictEqual(['Done', 'Done', 'Optional'])
  })

  it('offers Authorize as me for the fork\'s App at step 3, optional until the person authorized it', async () => {
    const assign = stubLocationAssign('/agents/connections')
    const page = 'https://github.com/login/oauth/authorize?client_id=Iv23li&state=a1'
    renderConnections({
      [AUTHORIZATIONS]: () => ({ authorizations: [] }),
      'POST /agents/engineering/github-apps/271828/authorize': () => ({ authorize_url: page, expires_at: 'later' }),
    }, [publicRead(), forkOf()], [OAUTH_APP])
    const card = await cardOf()
    const step3 = within(card.getByTestId('contribute-step-3'))
    await userEvent.click(await step3.findByRole('button', { name: 'Authorize as me voc-agents-3f9a2c' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(page) })
    expect(statuses()[2]).toStrictEqual(['3. Optional: open pull requests for you', 'Optional'])
  })

  it('marks step 3 done, as whom, once the person\'s authorizations list the fork\'s App', async () => {
    renderConnections({
      [AUTHORIZATIONS]: () => ({ authorizations: [{ app_id: '271828', login: 'alice', authorized_at: null, refresh_expires_at: null }] }),
    }, [publicRead(), forkOf()], [OAUTH_APP])
    const step3 = within((await cardOf()).getByTestId('contribute-step-3'))
    expect(await step3.findByText('Done')).toBeInTheDocument()
    expect([step3.getByText('Authorized as @alice'), step3.queryByRole('button')]).toStrictEqual([step3.getByText('Authorized as @alice'), null])
  })

  it('points to the App\'s OAuth client at step 3 for an App made before 7.57.00', async () => {
    renderConnections({}, [publicRead()], [githubApp()])
    const step3 = within((await cardOf()).getByTestId('contribute-step-3'))
    expect(step3.getByText('First set the App\'s OAuth client: Set the App\'s OAuth client… on the voc-agents-3f9a2c card.'))
      .toBeInTheDocument()
    expect(step3.queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Set the App\'s OAuth client…' })).toHaveLength(1)
  })

  it('asks nothing of the server until the licence is acknowledged', async () => {
    renderConnections({ [FORK]: () => links }, [publicRead()])
    const dialog = await openStep2()
    await userEvent.click(dialog.getByRole('button', { name: 'Continue' }))
    expect(dialog.getByText('Tick this to contribute under the repository\'s licence.')).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([path]) => path.endsWith('/fork'))).toHaveLength(0)
  })

  it('sends the destination and the licence, then goes to the App\'s install page in this tab', async () => {
    const assign = stubLocationAssign('/agents/connections')
    renderConnections({ [FORK]: () => links }, [publicRead()])
    const dialog = await openStep2()
    await userEvent.click(dialog.getByLabelText('An organization I administer'))
    await userEvent.type(dialog.getByLabelText('Organization'), 'my-org')
    await userEvent.click(dialog.getByLabelText('I have read the MIT licence and contribute under it'))
    await userEvent.click(dialog.getByRole('button', { name: 'Continue' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(links.install_url) })
    expect(sentFetchApiBody('/agents/engineering/connections/lint-kit/fork', 'POST'))
      .toStrictEqual({ account: 'organization', org: 'my-org', licence: 'MIT', app_id: '271828' })
  })

  it('says the server\'s refusal in its words (a licence changed, an opt-out)', async () => {
    renderConnections({ [FORK]: () => { throw new ApiError(409, 'open-tools/lint-kit opts out of bot pull requests (no-bot-prs)') } },
      [publicRead()])
    const dialog = await openStep2()
    await userEvent.click(dialog.getByLabelText('I have read the MIT licence and contribute under it'))
    await userEvent.click(dialog.getByRole('button', { name: 'Continue' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('opts out of bot pull requests')
  })
})

describe('a fork connection', () => {
  const UPSTREAM = 'PUT /agents/engineering/connections/lint-kit-fork/upstream'

  it('says its upstream, its owner, the licence and its runs\' outcome, and has no edit in its menu', async () => {
    renderConnections({}, [forkOf()])
    const row = within(await screen.findByTestId('connection-row-lint-kit-fork'))
    expect([row.getByText('Fork of open-tools/lint-kit'), row.getByText(/Owner: alice/), row.getByText(/Licence acknowledged: MIT/),
      row.getByText(/one click away: alice clicks Create on GitHub, or the app opens it for them once authorized\. Only the upstream's maintainers merge it\./)])
      .toHaveLength(4)
    await userEvent.click(row.getByRole('button', { name: 'Actions for alice/lint-kit' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).not.toContain('Change default branch…')
  })

  it('lets its owner open upstream pull requests for AI-assisted runs', async () => {
    renderConnections({ [UPSTREAM]: () => ({ connection: forkOf({ upstream_pr_assisted: true }) }) }, [forkOf()])
    const toggle = await screen.findByRole('switch', { name: 'Open upstream pull requests for AI-assisted runs' })
    await userEvent.click(toggle)
    await waitFor(() => { expect(sentFetchApiBody('/agents/engineering/connections/lint-kit-fork/upstream', 'PUT')).toStrictEqual({ assisted: true }) })
    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Open upstream pull requests for AI-assisted runs' })).toBeChecked() })
  })

  it('shows anyone but its owner the switch as it stands, disabled, and why', async () => {
    renderConnections({}, [forkOf({ owned_by_me: false })])
    const toggle = await screen.findByRole('switch', { name: 'Open upstream pull requests for AI-assisted runs' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAccessibleDescription('Only alice, the connection\'s owner, can change this.')
  })
})

describe('the person\'s authorization of an App', () => {
  it('offers Authorize as me, which opens GitHub\'s authorization page in this tab', async () => {
    const assign = stubLocationAssign('/agents/connections')
    const page = 'https://github.com/login/oauth/authorize?client_id=Iv23li&state=a1'
    renderConnections({
      [AUTHORIZATIONS]: () => ({ authorizations: [] }),
      'POST /agents/engineering/github-apps/271828/authorize': () => ({ authorize_url: page, expires_at: 'later' }),
    }, [forkOf()], [githubApp({ oauth: true, client_id: 'Iv23li', connections: ['lint-kit-fork'] })])
    await userEvent.click(await screen.findByRole('button', { name: 'Authorize as me voc-agents-3f9a2c' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(page) })
  })

  it('says who it is authorized as, and removes it after a confirmation', async () => {
    renderConnections({
      [AUTHORIZATIONS]: () => ({ authorizations: [{ app_id: '271828', login: 'alice', authorized_at: null, refresh_expires_at: null }] }),
      'DELETE /agents/engineering/github-apps/271828/authorization': () => ({ removed: true }),
    }, [forkOf()], [githubApp({ oauth: true, client_id: 'Iv23li', connections: ['lint-kit-fork'] })])
    expect(await screen.findByText('Authorized as @alice')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove my authorization' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Your authorization of voc-agents-3f9a2c is removed.')).toBeInTheDocument()
  })

  it('stores an older App\'s OAuth client, the secret sent and never shown back', async () => {
    renderConnections({ 'PUT /agents/engineering/github-apps/271828/oauth': () => ({ app: githubApp({ oauth: true, client_id: 'Iv1.abc12345' }) }) },
      [publicRead()], [githubApp({ connections: [] })])
    await userEvent.click(await screen.findByRole('button', { name: 'Set the App\'s OAuth client…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'The OAuth client of voc-agents-3f9a2c' }))
    expect(dialog.getByText(/\/agents\/connections\/github\/authorized$/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: 'Save the client' }))
    expect(dialog.getByText('The client id as GitHub shows it (letters, digits and dots).')).toBeInTheDocument()
    await userEvent.type(dialog.getByLabelText('Client id'), 'Iv1.abc12345')
    await userEvent.type(dialog.getByLabelText('Client secret'), 'a-client-secret-for-tests')
    await userEvent.click(dialog.getByRole('button', { name: 'Save the client' }))
    await waitFor(() => {
      expect(sentFetchApiBody('/agents/engineering/github-apps/271828/oauth', 'PUT'))
        .toStrictEqual({ client_id: 'Iv1.abc12345', client_secret: 'a-client-secret-for-tests' })
    })
    expect(await screen.findByText('The OAuth client of voc-agents-3f9a2c is stored.')).toBeInTheDocument()
  })
})
