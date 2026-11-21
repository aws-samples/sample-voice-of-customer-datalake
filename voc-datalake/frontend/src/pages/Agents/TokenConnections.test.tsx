/**
 * @fileoverview A public repository connected with a fine-grained token on Agents → Connections (7.60.00): Add a
 * repository's three ways (each with when to use it and what a run ends with; the token's and the fork's held until the
 * deployment's App can read; the App's install link; the fork's way to the public search), the token dialog (the steps on
 * GitHub and its prefilled page once the repository is known, a repository found on GitHub and picked, the token's shape
 * and the tick checked before anything is sent, the POST with `only_this_repository: true`, each refusal code in plain
 * words, the token never kept once saved), the token rows (their token line, the warn chip within 14 days and the danger
 * chip once expired, Replace token as their one action and in their "⋯", the replace dialog's PUT) and the removal's
 * reminder to revoke the token on GitHub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { stubLocationAssign } from '@test/location'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { chooseInRowMenu } from '@test/connectionDialog'
import { appConnection, githubApp } from '@test/githubAppFixtures'
import { FAKE_TOKEN, tokenConnection } from '@test/tokenConnectionFixtures'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const LIST = 'GET /agents/engineering/connections'
const APPS = 'GET /agents/engineering/github-apps'
const CREATE = 'POST /agents/engineering/token-connections'
const BILLING = appConnection('billing-api', 'example-org/billing-api')
const SDK = tokenConnection('partner-sdk', 'partner-org/sdk', 60)

function renderConnections(routes: Record<string, RouteHandler> = {}, connections: unknown[] = [BILLING], apps: unknown[] = [githubApp()]) {
  routeFetchApi({ [LIST]: () => ({ connections, limit: 20 }), [APPS]: () => ({ apps, limit: 5 }), ...routes }, { missStatus: 500 })
  const client = createTestQueryClient()
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, client)
  return client
}

const way = async (name: string) => within(await screen.findByTestId(`add-way-${name}`))
const posted = () => fetchApi.mock.calls.filter(([path, options]) => path === '/agents/engineering/token-connections' && options?.method === 'POST')

async function openTokenDialog() {
  await userEvent.click((await way('token')).getByRole('button', { name: 'Use a token…' }))
  return screen.getByRole('dialog', { name: 'Connect a repository with a fine-grained token' })
}

async function fill(dialog: HTMLElement, { repository = 'partner-org/sdk', token = FAKE_TOKEN, tick = true } = {}) {
  const inside = within(dialog)
  if (repository !== '') await userEvent.type(inside.getByLabelText('Repository'), repository)
  if (token !== '') {
    inside.getByLabelText('Fine-grained token').focus()
    await userEvent.paste(token)
  }
  if (tick) await userEvent.click(inside.getByRole('checkbox', { name: `This token can reach only ${repository}` }))
}

const submit = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole('button', { name: 'Check and connect' }))

beforeEach(() => {
  resetFetchApi()
  return stubElementScrollIntoView()
})

describe('Add a repository', () => {
  it('offers the three ways, each with when to use it and what the run ends with, every button secondary', async () => {
    renderConnections()
    const section = within(await screen.findByRole('region', { name: 'Add a repository' }))
    expect(section.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent))
      .toStrictEqual(['Install the GitHub App', 'Use a fine-grained token', 'Contribute through a fork'])
    expect([(await way('token')).getByText('A branch and a pull request on the repository, pushed with your token after your go.'),
      (await way('fork')).getByText(/a one-click link to open it on the repository/)]).toHaveLength(2)
    expect(section.getAllByText('Use this when')).toHaveLength(3)
    expect(document.querySelectorAll('[data-testid="add-repository"] .btn-primary')).toHaveLength(0)
  })

  it('holds the token\'s and the fork\'s ways until the deployment\'s App can read, offering Create the App instead', async () => {
    renderConnections({}, [{ ...BILLING, credential: { ...BILLING.credential, kind: 'app' } }], [])
    const token = await way('token')
    expect([token.getByRole('button', { name: 'Use a token…' }).getAttribute('aria-disabled'),
      token.queryByText(/Install this deployment's GitHub App on one of your repositories first/) !== null]).toStrictEqual(['true', true])
    await userEvent.click(token.getByRole('button', { name: 'Use a token…' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await way('fork')).getByRole('button', { name: 'Find the repository' })).toHaveAttribute('aria-disabled', 'true')
    expect((await way('app')).getByRole('button', { name: 'Create the App on GitHub' })).toHaveClass('btn-secondary')
  })

  it('takes the App\'s way to its install link, in this tab', async () => {
    const assign = stubLocationAssign('/agents/connections')
    const install = 'https://github.com/apps/voc-agents-3f9a2c/installations/new?state=s9'
    renderConnections({ 'POST /agents/engineering/github-apps/271828/install': () => ({ install_url: install, expires_at: '2026-11-20T11:00:00Z' }) })
    await userEvent.click((await way('app')).getByRole('button', { name: 'Add repositories to voc-agents-3f9a2c' }))
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(install) })
  })

  it('takes the fork\'s way to the public repositories\' search, focused', async () => {
    renderConnections()
    await userEvent.click((await way('fork')).getByRole('button', { name: 'Find the repository' }))
    const picker = within(screen.getByRole('region', { name: 'Add a public repository' }))
    expect(picker.getByLabelText('Repository')).toHaveFocus()
  })
})

describe('the token dialog', () => {
  it('says what to make on GitHub once the repository is known, with GitHub\'s page prefilled', async () => {
    renderConnections()
    const dialog = await openTokenDialog()
    expect(within(dialog).queryByTestId('token-steps')).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('Repository'), 'https://github.com/partner-org/sdk')
    const steps = within(within(dialog).getByTestId('token-steps'))
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual([
      'Resource owner: partner-org.', 'Repository access: Only select repositories, then partner-org/sdk alone.',
      expect.stringMatching(/^Repository permissions: Contents and Pull requests, both Read and write/),
      'Expiration: 90 days or less.',
    ])
    const link = new URL(steps.getByRole('link').getAttribute('href') ?? '')
    expect([link.pathname, link.searchParams.get('target_name'), link.searchParams.get('contents'),
      link.searchParams.get('pull_requests'), link.searchParams.get('expires_in'), steps.getByRole('link').getAttribute('target'),
      within(dialog).getByLabelText('Fine-grained token').getAttribute('type')])
      .toStrictEqual(['/settings/personal-access-tokens/new', 'partner-org', 'write', 'write', '90', '_blank', 'password'])
  })

  it('checks the repository, the token and the tick before anything is sent', async () => {
    renderConnections()
    const dialog = await openTokenDialog()
    await submit(dialog)
    expect(within(dialog).getByText('Name a GitHub repository as owner/name, or paste its address.')).toBeInTheDocument()
    await fill(dialog, { token: `ghp_${'a'.repeat(36)}`, tick: false })
    await submit(dialog)
    expect([within(dialog).getByText(/This is a classic, OAuth or App token/),
      within(dialog).getByText('Confirm that the token can reach only partner-org/sdk.')]).toHaveLength(2)
    expect(posted()).toStrictEqual([])
  })

  it('finds the repository on GitHub, offering only one that takes a token', async () => {
    renderConnections({ 'GET /agents/engineering/public-repositories?q=sdk': () => ({ repositories: [
      { repository: 'partner-org/sdk', stars: 3, licence: null, archived: false },
      { repository: 'partner-org/old-sdk', stars: 1, licence: null, archived: true },
    ] }) })
    const dialog = await openTokenDialog()
    await userEvent.type(within(dialog).getByLabelText('Repository'), 'sdk')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Find on GitHub' }))
    const results = within(await within(dialog).findByRole('list', { name: 'Public repositories found' }))
    expect(results.getByText('Archived: it takes no pushes')).toBeInTheDocument()
    await userEvent.click(results.getByRole('button', { name: 'Use partner-org/sdk' }))
    expect(within(dialog).getByLabelText('Repository')).toHaveValue('partner-org/sdk')
  })

  it('saves the connection with the tick sent, says so, and keeps no token once saved', async () => {
    const client = renderConnections({ [CREATE]: () => ({ connection: SDK, created: true }) })
    const dialog = await openTokenDialog()
    await fill(dialog)
    await submit(dialog)
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
    expect(sentFetchApiBody('/agents/engineering/token-connections', 'POST'))
      .toStrictEqual({ repository: 'partner-org/sdk', token: FAKE_TOKEN, only_this_repository: true })
    expect(screen.getByRole('status')).toHaveTextContent('partner-org/sdk is connected with your fine-grained token.')
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state))).not.toContain(FAKE_TOKEN)
  })

  it.each([
    ['org_pending_approval', /waits for the organization's approval/],
    ['expires_too_late', /lasts more than 90 days/],
    ['private_repository', /partner-org\/sdk is private/],
    ['other_repositories', /reaches other repositories/],
  ])('says a %s refusal in plain words', async (code, words) => {
    renderConnections({ [CREATE]: () => { throw new ApiError(422, 'server words', code) } })
    const dialog = await openTokenDialog()
    await fill(dialog)
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(words)
    expect(within(dialog).queryByText('server words')).not.toBeInTheDocument()
  })

  it('says a conflict in the server\'s own words', async () => {
    renderConnections({ [CREATE]: () => { throw new ApiError(409, 'this repository is connected already (as sdk)') } })
    const dialog = await openTokenDialog()
    await fill(dialog)
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('this repository is connected already (as sdk)')
  })
})

describe('a token connection\'s row', () => {
  it('says its token, whose it is and when it expires, in a card of its own', async () => {
    renderConnections({}, [BILLING, SDK])
    const card = within(await screen.findByRole('list', { name: 'Fine-grained tokens' }))
    const line = within(card.getByTestId('token-line-partner-sdk'))
    expect(line.getByText(/^Fine-grained token · casey-dev · expires .* \(in 60 days\)$/)).toBeInTheDocument()
    expect(line.getByText('Saved by you: only you give a run on it its go.')).toBeInTheDocument()
    expect(screen.getByTestId('connections-status')).toHaveTextContent('1 repository with a fine-grained token')
  })

  it.each([
    [10, 'Expires in 10 days', 'badge-warn'],
    [0, 'Token expired', 'badge-danger'],
  ])('shows a chip at %i days left, and Replace token as its one action', async (days, chip, tone) => {
    renderConnections({}, [tokenConnection('partner-sdk', 'partner-org/sdk', days, { savedByYou: false, owner: 'Robin' })])
    const row = within(await screen.findByTestId('connection-row-partner-sdk'))
    expect(row.getByText(chip)).toHaveClass(tone)
    expect(row.getByText('Saved by Robin: only they give a run on it its go.')).toBeInTheDocument()
    await userEvent.click(row.getByRole('button', { name: 'Replace token partner-org/sdk' }))
    expect(screen.getByRole('dialog', { name: 'Replace the token of partner-org/sdk' })).toBeInTheDocument()
  })

  it('replaces its token from its "⋯", on its own repository', async () => {
    renderConnections({ 'PUT /agents/engineering/connections/partner-sdk/token': () => ({ connection: SDK }) }, [BILLING, SDK])
    await chooseInRowMenu('Actions for partner-org/sdk', 'Replace token…')
    const dialog = screen.getByRole('dialog', { name: 'Replace the token of partner-org/sdk' })
    expect(within(dialog).queryByLabelText('Repository')).not.toBeInTheDocument()
    within(dialog).getByLabelText('Fine-grained token').focus()
    await userEvent.paste(FAKE_TOKEN)
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'This token can reach only partner-org/sdk' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check and replace' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
    expect(sentFetchApiBody('/agents/engineering/connections/partner-sdk/token', 'PUT'))
      .toStrictEqual({ token: FAKE_TOKEN, only_this_repository: true })
    expect(screen.getByRole('status')).toHaveTextContent('The token of partner-org/sdk is replaced.')
  })

  it('reminds the person to revoke the token on GitHub when it is removed', async () => {
    renderConnections({}, [BILLING, SDK])
    await chooseInRowMenu('Actions for partner-org/sdk', 'Remove connection…')
    expect(within(screen.getByRole('dialog')).getByText(/Revoke it on GitHub too/)).toBeInTheDocument()
  })

  it('names a fine-grained token in its details', async () => {
    renderConnections({}, [BILLING, SDK])
    await userEvent.click(await screen.findByRole('button', { name: 'Connection details for partner-org/sdk' }))
    const details = within(screen.getByRole('dialog', { name: 'Connection details' }))
    expect([details.getByText('GitHub · Fine-grained token'), details.getByText('Token expires')]).toHaveLength(2)
  })
})
