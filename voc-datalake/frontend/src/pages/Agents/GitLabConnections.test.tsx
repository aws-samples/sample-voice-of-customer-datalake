/**
 * @fileoverview Agents → Connections for GitLab: the dialog's host choice (GitHub's App fields or GitLab's project path
 * and token; More ways to connect → GitLab opens it on GitLab), the GitLab token's guidance (role, scopes, expiry), the
 * request a GitLab save sends (the token never kept nor shown back), an edit through the row's "⋯" that keeps the stored
 * token, the token's expiry on the row (its day, a warning within 30 days, a danger once past: Replace token is then the
 * row's action), the host and the token's kind in the row's details, no issues column for GitLab, and the CI
 * attestation's points in GitLab's words. GitHub's own flows are EngineeringConnections.test.tsx's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { said } from '@test/describedField'
import { chooseInRowMenu, openAddConnection, saveConnection } from '@test/connectionDialog'
import type { RouteHandler } from '@test/fetchApiRoutes'

// A fake token: the shape GitLab's tokens have, nothing more.
const FILLER = 'x'.repeat(24)
const TOKEN = `glpat-${FILLER}`
const LIST = 'GET /agents/engineering/connections'
const PUT = 'PUT /agents/engineering/connections/docs'
const REPOSITORY = 'example-group/web/docs'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const { EngineeringConnections } = await import('./EngineeringConnections')

/** A calendar day `days` from today (UTC). */
const dayAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const gitlab = (expiresAt: string | null, fields: Record<string, unknown> = {}) => ({
  connection_id: 'docs', host: 'gitlab', repository: REPOSITORY, default_branch: 'main', version: 2,
  credential: { kind: 'project_token', set: true, app_id: null, installation_id: null, expires_at: expiresAt },
  created_at: '2026-11-01T10:00:00Z', created_by: 'admin-a', updated_at: '2026-11-02T10:00:00Z', updated_by: 'admin-b',
  ...fields,
})

/** The page over `listed` (the GitLab save's PUT answered by `put` when given): its query client. */
function renderConnections(listed: readonly unknown[], put?: RouteHandler) {
  const client = createTestQueryClient()
  routeFetchApi({
    [LIST]: () => ({ connections: listed, limit: 20 }), 'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }),
    ...(put === undefined ? {} : { [PUT]: put }),
  }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, client)
  return client
}

/** Type `value` in place of what the dialog's field `label` holds. */
async function retype(dialog: HTMLElement, label: string, value: string) {
  const input = within(dialog).getByLabelText(label)
  await userEvent.clear(input)
  await userEvent.type(input, value)
}

const openAdd = openAddConnection
const chooseGitlab = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole('radio', { name: 'GitLab' }))
const save = saveConnection

/** The add dialog over an empty list, on GitLab, its id typed: the dialog. */
async function addGitlab(put: RouteHandler) {
  const client = renderConnections([], put)
  const dialog = await openAdd()
  await chooseGitlab(dialog)
  await userEvent.type(within(dialog).getByLabelText('Connection id'), 'docs')
  return { client, dialog }
}

beforeEach(() => { resetFetchApi() })

describe('the host choice', () => {
  it('starts on GitLab from More ways to connect → GitLab', async () => {
    renderConnections([])
    const dialog = await openAdd('gitlab')
    expect([within(dialog).getByRole('radio', { name: 'GitLab' }), within(dialog).getByLabelText('Project access token')])
      .toStrictEqual([expect.objectContaining({ checked: true }), expect.anything()])
  })

  it('starts on GitHub with the App\'s fields, and GitLab swaps them for the project path and token', async () => {
    renderConnections([])
    const dialog = await openAdd()
    expect([within(dialog).getByRole('radio', { name: 'GitHub' }), within(dialog).queryByLabelText('Project access token')])
      .toStrictEqual([expect.objectContaining({ checked: true }), null])
    await chooseGitlab(dialog)
    expect([within(dialog).queryByLabelText('App id'), within(dialog).queryByLabelText('Private key')]).toStrictEqual([null, null])
    expect([within(dialog).getByLabelText('Project path'), within(dialog).getByLabelText('Project access token')])
      .toStrictEqual([expect.objectContaining({ value: '' }), expect.objectContaining({ value: '', autocomplete: 'off' })])
  })

  it('says what the GitLab token needs: its role, its scopes and its expiry', async () => {
    renderConnections([])
    const dialog = await openAdd()
    await chooseGitlab(dialog)
    const guidance = within(dialog).getByRole('region', { name: 'What the GitLab token needs' })
    expect(guidance).toHaveTextContent('role Developer, scopes api, read_repository and write_repository')
    expect(guidance).toHaveTextContent('at most a year after they are made')
    expect(within(dialog).queryByRole('region', { name: 'What the credential needs' })).not.toBeInTheDocument()
  })
})

describe('saving a GitLab connection', () => {
  it('sends the project\'s path and the token, and never shows the token back nor caches it', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: gitlab(dayAhead(300)), created: true }))
    const { client, dialog } = await addGitlab(put)
    await userEvent.type(within(dialog).getByLabelText('Project path'), REPOSITORY)
    within(dialog).getByLabelText('Project access token').focus()
    await userEvent.paste(TOKEN)
    await save(dialog)
    expect(await screen.findByText(`${REPOSITORY} is added.`)).toHaveAttribute('role', 'status')
    expect(put.mock.calls).toStrictEqual([[{ host: 'gitlab', repository: REPOSITORY, default_branch: 'main', credential: { token: TOKEN } }]])
    expect(JSON.stringify([client.getQueryCache().getAll().map((q) => q.state.data),
      client.getMutationCache().getAll().map((m) => m.state.variables), document.body.innerHTML]).includes(FILLER)).toBe(false)
  })

  it('says what is wrong with the path and the token before anything is sent', async () => {
    const put = vi.fn()
    const { dialog } = await addGitlab(put)
    await userEvent.type(within(dialog).getByLabelText('Project path'), 'docs.git')
    await userEvent.type(within(dialog).getByLabelText('Project access token'), 'not-a-token')
    await save(dialog)
    expect([said(dialog, 'Project path'), said(dialog, 'Project access token'), put.mock.calls]).toStrictEqual([
      ['true', 'Enter the project’s path as in its address: group/project or group/subgroup/project.'],
      ['true', 'Paste the whole project access token: it starts with glpat-.'], [],
    ])
  })

  it('keeps the stored token on an edit that changes only the branch', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: gitlab(dayAhead(300), { default_branch: 'trunk' }), created: false }))
    renderConnections([gitlab(dayAhead(300))], put)
    await chooseInRowMenu(`Actions for ${REPOSITORY}`, 'Edit connection…')
    const dialog = screen.getByRole('dialog', { name: `Edit the connection to ${REPOSITORY}` })
    expect([within(dialog).getByRole('radio', { name: 'GitLab' }), dialog.textContent.includes('Leave the token empty to keep it')])
      .toStrictEqual([expect.objectContaining({ checked: true }), true])
    await retype(dialog, 'Default branch', 'trunk')
    await save(dialog)
    expect(await screen.findByText(`${REPOSITORY} is saved.`)).toHaveAttribute('role', 'status')
    expect(put.mock.calls).toStrictEqual([[{ host: 'gitlab', repository: REPOSITORY, default_branch: 'trunk' }]])
  })
})

describe('a GitLab token\'s expiry on the row', () => {
  const row = async (expiresAt: string | null) => {
    renderConnections([gitlab(expiresAt)])
    return within(await screen.findByTestId('connection-row-docs'))
  }

  it('shows its day while it is far, the host and the token\'s kind in the details, no issues column', async () => {
    const found = await row(dayAhead(200))
    expect(found.getByText(/^Token expires on /)).toBeInTheDocument()
    expect([found.queryByText('Token expires soon'), found.queryByRole('button', { name: `Replace token ${REPOSITORY}` }),
      found.queryByRole('switch')]).toStrictEqual([null, null, null])
    expect(found.getByText('GitHub only')).toHaveClass('sr-only')
    await userEvent.click(found.getByRole('button', { name: `Connection details for ${REPOSITORY}` }))
    expect(screen.getByRole('dialog', { name: 'Connection details' })).toHaveTextContent('GitLab · GitLab project access token')
  })

  it('warns within 30 days, Replace token its action (the Edit dialog)', async () => {
    const found = await row(dayAhead(10))
    expect(found.getByText('Token expires soon')).toHaveClass('badge-warn')
    expect(found.getByText(/within 30 days: make a new token/)).toBeInTheDocument()
    await userEvent.click(found.getByRole('button', { name: `Replace token ${REPOSITORY}` }))
    expect(screen.getByRole('dialog', { name: `Edit the connection to ${REPOSITORY}` })).toBeInTheDocument()
  })

  it('says a past expiry as a danger, Replace token its action', async () => {
    const found = await row(dayAhead(-3))
    expect(found.getByText('Token expired')).toHaveClass('badge-danger')
    expect(found.getByText(/the agents cannot reach the project until you save a new token/)).toBeInTheDocument()
    expect(found.getByRole('button', { name: `Replace token ${REPOSITORY}` })).toBeInTheDocument()
  })

  it('says when the expiry is not known', async () => {
    const found = await row(null)
    expect(found.getByText(/expiry is not known/)).toBeInTheDocument()
  })
})

describe('a GitLab connection\'s CI attestation', () => {
  it('names GitLab\'s settings for the six points', async () => {
    renderConnections([gitlab(dayAhead(200))])
    await userEvent.click(await screen.findByRole('button', { name: `Attest CI ${REPOSITORY}` }))
    const dialog = screen.getByRole('dialog', { name: `Attest the CI of ${REPOSITORY}` })
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6)
    expect(within(dialog).getByLabelText(/CI\/CD variables that hold secrets are protected/)).not.toBeChecked()
    expect([dialog.textContent.includes('id_tokens'), dialog.textContent.includes('pull_request_target')]).toStrictEqual([true, false])
  })
})
