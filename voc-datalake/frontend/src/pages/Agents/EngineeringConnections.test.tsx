/**
 * @fileoverview Agents → Connections (7.52.00): each repository as a row (its repository, branch and CI; no id as
 * content: the connection id, the App's and the installation's only in its details, never a secret), a missing
 * credential's Store the key, the nothing-connected hero and its one primary, More ways to connect folded, the
 * load-failed states, adding one (the PUT with the App's credential, whose key is never shown back nor kept in the
 * query cache), editing one through its "⋯" (its id fixed; an empty key keeps the stored credential, a new repository
 * asks for the key again), removing one after a confirmation that names it (the DELETE), a server's 409 said in its own
 * words, what the App needs, and the form's own checks before anything is sent. Where the tab is offered is
 * Agents.test.tsx's.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { sortedStrings } from '@test/stringLists'
import { said } from '@test/describedField'
import { addConnectionButton, chooseInRowMenu, openAddConnection, saveConnection } from '@test/connectionDialog'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

// An obviously fake key, built at runtime so nothing reads it as a real one: the PEM shape around base64 filler.
const FILLER = 'Q'.repeat(64)
const PEM = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', FILLER, FILLER, '-----END RSA ' + 'PRIVATE KEY-----'].join('\n')

const connection = (id: string, repository: string, credential: Record<string, unknown>) => ({
  connection_id: id, host: 'github', repository, default_branch: 'main', credential,
  created_at: '2026-11-01T10:00:00Z', created_by: 'admin-a', updated_at: '2026-11-02T10:00:00Z', updated_by: 'admin-b',
})
const WEB = connection('web-app', 'example-org/web-app', { kind: 'app', set: true, app_id: '123', installation_id: '456' })
const API = connection('api', 'example-org/api', { kind: 'app', set: false, app_id: '321', installation_id: '654' })
const LIST = 'GET /agents/engineering/connections'
/** The deployment's GitHub Apps: none, unless a test says otherwise. */
const NO_APPS = { 'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }) }

function renderConnections(routes: Record<string, RouteHandler>) {
  routeFetchApi({ ...NO_APPS, ...routes }, { missStatus: 500 })
  const client = createTestQueryClient()
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, client)
  return client
}

const calls = (method: string) => fetchApi.mock.calls.filter(([, options]) => options?.method === method)
const openAdd = openAddConnection
const save = saveConnection
const rowOf = async (id: string) => within(await screen.findByTestId(`connection-row-${id}`))

async function pasteKey(dialog: HTMLElement, key = PEM) {
  within(dialog).getByLabelText('Private key').focus()
  await userEvent.paste(key)
}

async function fillNew(dialog: HTMLElement, { id = 'web-app', repository = 'example-org/web-app', appId = '123',
  installationId = '456', key = PEM } = {}) {
  for (const [label, value] of [['Connection id', id], ['Repository', repository], ['App id', appId],
    ['Installation id', installationId]] as const) {
    if (value !== '') await userEvent.type(within(dialog).getByLabelText(label), value)
  }
  if (key !== '') await pasteKey(dialog, key)
}

/** Open the row's details (ⓘ): the popover. */
async function openDetails(repository: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Connection details for ${repository}` }))
  return screen.getByRole('dialog', { name: 'Connection details' })
}

beforeEach(() => { resetFetchApi() })

describe('the connections list', () => {
  it('shows each repository with its branch and CI, and keeps every id out of the row', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB, API], limit: 20 }) })
    const web = await rowOf('web-app')
    expect([web.getByText('example-org/web-app'), web.getByText('Default branch: main'), web.getByText('CI not attested')])
      .toHaveLength(3)
    expect([screen.queryByText('web-app'), screen.queryByText(/App 123/), screen.queryByText('456')]).toStrictEqual([null, null, null])
    expect(screen.getByRole('list', { name: 'Other connections' })).toBeInTheDocument()
    expect(screen.getByTestId('connections-status')).toHaveTextContent('2 other connections · 2 need their CI attested before the agents push')
  })

  it('holds the ids, the key\'s state and the last change in the row\'s details, with a copy for each id', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }) })
    await user.click(await screen.findByRole('button', { name: 'Connection details for example-org/web-app' }))
    const details = within(screen.getByRole('dialog', { name: 'Connection details' }))
    expect([details.getByText('web-app'), details.getByText('123'), details.getByText('456'), details.getByText('Stored, never shown'),
      details.getByText('GitHub · GitHub App'), details.getByText(/admin-b/)]).toHaveLength(6)
    expect(details.getByText('web-app')).toHaveClass('font-mono')
    await user.click(details.getByRole('button', { name: 'Copy Connection id' }))
    expect(writeText).toHaveBeenCalledWith('web-app')
    expect(await screen.findByText('Copied', { selector: '[role="status"]' })).toBeInTheDocument()
  })

  it('closes the details on Escape, the focus back on their button', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }) })
    await openDetails('example-org/web-app')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Connection details' })).not.toBeInTheDocument() })
    expect(screen.getByRole('button', { name: 'Connection details for example-org/web-app' })).toHaveFocus()
  })

  it('says a missing credential on its row, whose one action is Store the key (its Edit dialog)', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB, API], limit: 20 }) })
    const api = await rowOf('api')
    expect(api.getByText(/save it with its credential again/)).toBeInTheDocument()
    await userEvent.click(api.getByRole('button', { name: 'Store the key example-org/api' }))
    expect(screen.getByRole('dialog', { name: 'Edit the connection to example-org/api' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect((await openDetails('example-org/api')).textContent).toContain('Missing: store it again')
  })

  it('offers Connect GitHub as the page\'s one primary while nothing is connected, the other ways folded', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    const hero = await screen.findByRole('region', { name: 'Connect GitHub' })
    expect(within(hero).getByRole('button', { name: 'Create the App on GitHub' })).toHaveClass('btn-primary')
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1)
    const ways = screen.getAllByRole('button', { expanded: false })
    expect(ways.map((way) => way.textContent)).toStrictEqual([
      expect.stringMatching(/^Connect manually \(advanced\)/), expect.stringMatching(/^GitLab/),
    ])
    expect([screen.queryByRole('button', { name: 'Add a GitHub connection' }), screen.queryByText('Add another GitHub App'),
      screen.queryByTestId('connections-status')]).toStrictEqual([null, null, null])
  })

  it('says what a pasted App needs once its way is unfolded', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    await addConnectionButton('github')
    const guidance = screen.getByRole('region', { name: 'What the credential needs' })
    expect(guidance).toHaveTextContent('Contents, Pull requests and Issues set to Read and write')
    // A token holds at most the App's own permissions, the four the line above asks for.
    expect(guidance).toHaveTextContent(
      'Contents, Pull requests and Issues, read and write; Metadata, read-only; never admin')
  })

  it('says a failed load, and loads again on Retry', async () => {
    const user = userEvent.setup()
    renderConnections({ [LIST]: () => { throw new ApiError(503, 'unavailable') } })
    expect(await screen.findByText('The repository connections could not be loaded.')).toBeInTheDocument()
    routeFetchApi({ ...NO_APPS, [LIST]: () => ({ connections: [WEB], limit: 20 }) }, { missStatus: 500 })
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('example-org/web-app')).toBeInTheDocument()
  })

  it('reads an answer without a list as a failed load, never as "nothing connected"', async () => {
    renderConnections({ [LIST]: () => ({ items: [] }) })
    expect(await screen.findByText('The repository connections could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Connect GitHub' })).not.toBeInTheDocument()
  })

  it('offers no new connection at the limit', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 1 }) })
    expect(await addConnectionButton('github')).toBeDisabled()
    expect(screen.getByText(/at most 1 connections/)).toBeInTheDocument()
  })
})

describe('adding a connection', () => {
  it('sends the repository, branch and the App\'s credential, and never shows the key back nor caches it', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: WEB, created: true }))
    const client = renderConnections({
      [LIST]: () => ({ connections: [], limit: 20 }), 'PUT /agents/engineering/connections/web-app': put,
    })
    await fillNew(await openAdd())
    await save(screen.getByRole('dialog'))
    expect(await screen.findByText('example-org/web-app is added.')).toHaveAttribute('role', 'status')
    expect(put.mock.calls).toStrictEqual([[{
      host: 'github', repository: 'example-org/web-app', default_branch: 'main',
      credential: { app_id: '123', installation_id: '456', private_key: `${PEM}\n` },
    }]])
    expect([screen.queryByRole('dialog'), document.body.innerHTML.includes(FILLER)]).toStrictEqual([null, false])
    expect(JSON.stringify([client.getQueryCache().getAll().map((q) => q.state.data),
      client.getMutationCache().getAll().map((m) => m.state.variables)]).includes(FILLER)).toBe(false)
  })

  it('makes the private key\'s input write-only', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    const key = within(await openAdd()).getByLabelText('Private key')
    expect([key.tagName, key.getAttribute('autocomplete'), key.getAttribute('spellcheck'), key])
      .toStrictEqual(['TEXTAREA', 'off', 'false', expect.objectContaining({ value: '' })])
  })

  it('says what is wrong with each field before anything is sent, and focuses the first', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    const dialog = await openAdd()
    await fillNew(dialog, { id: 'Web_App', repository: 'example-org', appId: 'app', key: 'not a key' })
    await save(dialog)
    expect(within(dialog).getByLabelText('Connection id')).toHaveFocus()
    expect([said(dialog, 'Connection id')[1], said(dialog, 'Repository'), said(dialog, 'App id'), said(dialog, 'Private key')])
      .toStrictEqual([
        'Enter an id of 1 to 63 lowercase letters, digits or hyphens, starting with a letter or a digit.',
        ['true', 'Enter the repository as owner/name.'],
        ['true', 'Enter the App id: digits only.'],
        ['true', 'Paste the whole unencrypted RSA key in PEM, from its BEGIN line to its END line.'],
      ])
    expect(calls('PUT')).toStrictEqual([])
  })

  it('needs the private key to add a connection', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    const dialog = await openAdd()
    await fillNew(dialog, { key: '' })
    await save(dialog)
    expect(said(dialog, 'Private key')).toStrictEqual(['true', 'Paste the App’s private key: a new connection needs its credential.'])
    expect(within(dialog).getByLabelText('Private key')).toHaveFocus()
    expect(calls('PUT')).toStrictEqual([])
  })

  it('says a server\'s 409 in its own words and stays open', async () => {
    const reason = 'at most 20 connections: remove one to add another'
    renderConnections({
      [LIST]: () => ({ connections: [], limit: 20 }),
      'PUT /agents/engineering/connections/web-app': () => { throw new ApiError(409, reason) },
    })
    const dialog = await openAdd()
    await fillNew(dialog)
    await save(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason)
    expect(screen.getByRole('dialog')).toBe(dialog)
  })
})

describe('editing a connection', () => {
  const openEdit = async () => {
    await chooseInRowMenu('Actions for example-org/web-app', 'Edit connection…')
    return screen.getByRole('dialog', { name: 'Edit the connection to example-org/web-app' })
  }

  it('offers Edit connection…, the CI\'s attestation and the removal in the row\'s "⋯", the removal last', async () => {
    renderConnections({ [LIST]: () => ({ connections: [{ ...WEB, ci_attestation: null }, API], limit: 20 }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for example-org/api' }))
    // (the API row's one action is Store the key: Attest CI waits in its menu)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toStrictEqual(['Edit connection…', 'Attest CI…', 'Remove connection…'])
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Actions for example-org/web-app' }))
    // (its one action is Attest CI: not again in its menu)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Edit connection…', 'Remove connection…'])
  })

  it('keeps its id and the stored credential when only the branch changes', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: { ...WEB, default_branch: 'trunk' }, created: false }))
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }), 'PUT /agents/engineering/connections/web-app': put })
    const dialog = await openEdit()
    expect([within(dialog).getByLabelText('Connection id'), within(dialog).getByText('Set'), within(dialog).getByLabelText('App id'),
      within(dialog).getByLabelText('Private key')]).toStrictEqual([expect.objectContaining({ readOnly: true, value: 'web-app' }),
      expect.anything(), expect.objectContaining({ value: '123' }), expect.objectContaining({ value: '' })])
    expect(dialog).toHaveTextContent('Leave the private key empty to keep it')
    const branch = within(dialog).getByLabelText('Default branch')
    await userEvent.clear(branch)
    await userEvent.type(branch, 'trunk')
    await save(dialog)
    expect(await screen.findByText('example-org/web-app is saved.')).toHaveAttribute('role', 'status')
    expect(put.mock.calls).toStrictEqual([[{ host: 'github', repository: 'example-org/web-app', default_branch: 'trunk' }]])
  })

  it('asks for the private key again when the repository changes', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: { ...WEB, repository: 'example-org/web' }, created: false }))
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }), 'PUT /agents/engineering/connections/web-app': put })
    const dialog = await openEdit()
    const repository = within(dialog).getByLabelText('Repository')
    await userEvent.clear(repository)
    await userEvent.type(repository, 'example-org/web')
    await save(dialog)
    expect(said(dialog, 'Private key')[0]).toBe('true')
    expect(calls('PUT')).toStrictEqual([])
    await pasteKey(dialog)
    await save(dialog)
    await waitFor(() => expect(put.mock.calls).toStrictEqual([[{
      host: 'github', repository: 'example-org/web', default_branch: 'main',
      credential: { app_id: '123', installation_id: '456', private_key: `${PEM}\n` },
    }]]))
  })
})

describe('editing a connection the GitHub App saved', () => {
  const SANDBOX = connection('voc-agents-sandbox', 'mundurragacl/voc-agents-sandbox',
    { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926' })

  it('fits the viewport and scrolls its body, shows the App read only and offers only the branch and the reason', async () => {
    const put = vi.fn((_body: unknown) => ({ connection: { ...SANDBOX, default_branch: 'develop' }, created: false }))
    renderConnections({ [LIST]: () => ({ connections: [SANDBOX], limit: 20 }), 'PUT /agents/engineering/connections/voc-agents-sandbox': put })
    await chooseInRowMenu('Actions for mundurragacl/voc-agents-sandbox', 'Change default branch…')
    const dialog = screen.getByRole('dialog', { name: 'Edit the connection to mundurragacl/voc-agents-sandbox' })
    // At most the viewport's height; the body between the fixed header and footer scrolls (index.css .dialog-body).
    expect([(dialog.closest('.dialog-panel') ?? dialog).classList.contains('max-h-[90vh]'), dialog.querySelector('.dialog-body') !== null,
      within(dialog).getByTestId('connection-app-reference').textContent.includes('App 271828, installation 31415926')])
      .toStrictEqual([true, true, true])
    // Read only what is fixed; nothing of a pasted key: no host choice, no App fields to fill, no private key, no guidance.
    expect([within(dialog).getByLabelText('Connection id'), within(dialog).getByLabelText('Repository'),
      within(dialog).queryByLabelText('Private key'), within(dialog).queryByLabelText('App id'),
      within(dialog).queryByRole('radio', { name: 'GitLab' }), within(dialog).queryByText(/Leave the private key empty/)])
      .toStrictEqual([expect.objectContaining({ readOnly: true }), expect.objectContaining({ readOnly: true }), null, null, null, null])
    const branch = within(dialog).getByLabelText('Default branch')
    await userEvent.clear(branch)
    await userEvent.type(branch, 'develop')
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'The sandbox works on develop')
    await save(dialog)
    expect(await screen.findByText('mundurragacl/voc-agents-sandbox is saved.')).toHaveAttribute('role', 'status')
    expect(put.mock.calls).toStrictEqual([[{
      host: 'github', repository: 'mundurragacl/voc-agents-sandbox', default_branch: 'develop', reason: 'The sandbox works on develop',
    }]])
  })
})

describe('removing a connection', () => {
  it('asks first, naming the repository and what live runs lose, then sends the DELETE', async () => {
    const stored = new Map([[WEB.connection_id, WEB], [API.connection_id, API]])
    const remove = vi.fn(() => ({ removed: stored.delete('web-app') }))
    renderConnections({
      [LIST]: () => ({ connections: [...stored.values()], limit: 20 }), 'DELETE /agents/engineering/connections/web-app': remove,
    })
    await chooseInRowMenu('Actions for example-org/web-app', 'Remove connection…')
    const confirm = screen.getByRole('dialog', { name: 'Remove example-org/web-app?' })
    expect(confirm).toHaveTextContent('Runs working on example-org/web-app lose access within five minutes: their reads and writes fail until a connection is stored again.')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove connection' }))
    expect(await screen.findByText('example-org/web-app is removed.')).toHaveAttribute('role', 'status')
    expect([remove.mock.calls.length, screen.queryByText('example-org/web-app'), screen.getByText('example-org/api')])
      .toStrictEqual([1, null, expect.anything()])
  })

  it('sends nothing on Cancel, and Escape closes the confirmation', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }) })
    await chooseInRowMenu('Actions for example-org/web-app', 'Remove connection…')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect([screen.queryByRole('dialog'), calls('DELETE')]).toStrictEqual([null, []])
    await chooseInRowMenu('Actions for example-org/web-app', 'Remove connection…')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls('DELETE')).toStrictEqual([])
  })
})

const LOCALES_DIR = path.join(__dirname, '../../../public/locales')
const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'zh']
const guidanceSchema = z.object({ connections: z.object({ guidance: z.object({ token: z.string() }) }) })
const localeGuidance = (locale: string) => guidanceSchema.parse(
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'agents.json'), 'utf8'))).connections.guidance
const draftSchema = z.object({ connections: z.record(z.string(), z.unknown()) }).loose()

describe('what a token holds, in every locale', () => {
  it('covers the nine shipped locales', () => {
    expect(sortedStrings(fs.readdirSync(LOCALES_DIR))).toStrictEqual(LOCALES)
  })

  // The App's permissions, by the names its settings page shows: a token holds at most those (github.py).
  it.each(LOCALES)('%s names the App\'s four permissions in what a token holds', (locale) => {
    const { token } = localeGuidance(locale)
    expect(['Contents', 'Pull requests', 'Issues', 'Metadata'].filter((name) => !token.includes(name)))
      .toStrictEqual([])
  })

  // Pull requests open ready for review since 7.50 (ux-agents-redesign C5).
  it('never says "draft pull request" on Connections in English', () => {
    const bundle = draftSchema.parse(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en', 'agents.json'), 'utf8')))
    expect(JSON.stringify(bundle.connections)).not.toMatch(/draft pull request/i)
  })
})
