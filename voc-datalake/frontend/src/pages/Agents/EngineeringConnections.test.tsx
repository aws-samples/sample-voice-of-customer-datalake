/**
 * @fileoverview Agents → Connections: the list (each connection's repository, branch, its GitHub App's ids and whether
 * its credential is set, never a secret), the empty and load-failed states, adding one (the PUT with the App's
 * credential, whose key is never shown back nor kept in the query cache), editing one (its id fixed; an empty key keeps
 * the stored credential, a new repository asks for the key again), removing one after a confirmation that names it
 * (the DELETE), a server's 409 said in its own words, what the App needs, and the form's own checks before anything is
 * sent. Where the tab is offered is Agents.test.tsx's.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { at } from '@test/defined'
import { sortedStrings } from '@test/stringLists'
import { said } from '@test/describedField'
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

function renderConnections(routes: Record<string, RouteHandler>) {
  routeFetchApi(routes, { missStatus: 500 })
  const client = createTestQueryClient()
  renderWithQueryClient(<EngineeringConnections />, client)
  return client
}

const calls = (method: string) => fetchApi.mock.calls.filter(([, options]) => options?.method === method)
const openAdd = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }))
  return screen.getByRole('dialog', { name: 'Add a repository connection' })
}
const save = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole('button', { name: 'Save connection' }))

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

beforeEach(() => { resetFetchApi() })

describe('the connections list', () => {
  it('shows each connection\'s repository, branch, App and whether its credential is set', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB, API], limit: 20 }) })
    const rows = await screen.findAllByRole('listitem')
    const [web, api] = [within(at(rows, 0)), within(at(rows, 1))]
    expect(rows.map((row) => row.textContent.includes('Default branch: main'))).toStrictEqual([true, true])
    expect([web.getByText('GitHub App'), web.getByText('App 123, installation 456'), web.getByText('Set'),
      web.getByText(/admin-b/)]).toHaveLength(4)
    expect([api.getByText('Not set'), api.getByText(/save it with its credential again/)]).toHaveLength(2)
    expect(api.getByRole('button', { name: 'Edit example-org/api' })).toBeInTheDocument()
  })

  it('says when there is none yet, and what the App needs', async () => {
    renderConnections({ [LIST]: () => ({ connections: [], limit: 20 }) })
    expect(await screen.findByText('No repository connections yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeEnabled()
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
    routeFetchApi({ [LIST]: () => ({ connections: [WEB], limit: 20 }) }, { missStatus: 500 })
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('example-org/web-app')).toBeInTheDocument()
  })

  it('reads an answer without a list as a failed load, never as "no connections"', async () => {
    renderConnections({ [LIST]: () => ({ items: [] }) })
    expect(await screen.findByText('The repository connections could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('No repository connections yet')).not.toBeInTheDocument()
  })

  it('offers no new connection at the limit', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 1 }) })
    expect(await screen.findByRole('button', { name: 'Add connection' })).toBeDisabled()
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
    expect(await screen.findByRole('status')).toHaveTextContent('example-org/web-app is added.')
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
    await userEvent.click(await screen.findByRole('button', { name: 'Edit example-org/web-app' }))
    return screen.getByRole('dialog', { name: 'Edit the connection to example-org/web-app' })
  }

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
    expect(await screen.findByRole('status')).toHaveTextContent('example-org/web-app is saved.')
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

describe('removing a connection', () => {
  it('asks first, naming the repository and what live runs lose, then sends the DELETE', async () => {
    const stored = new Map([[WEB.connection_id, WEB], [API.connection_id, API]])
    const remove = vi.fn(() => ({ removed: stored.delete('web-app') }))
    renderConnections({
      [LIST]: () => ({ connections: [...stored.values()], limit: 20 }), 'DELETE /agents/engineering/connections/web-app': remove,
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove example-org/web-app' }))
    const confirm = screen.getByRole('dialog', { name: 'Remove example-org/web-app?' })
    expect(confirm).toHaveTextContent('Runs working on example-org/web-app lose access within five minutes: their reads and writes fail until a connection is stored again.')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove connection' }))
    expect(await screen.findByRole('status')).toHaveTextContent('example-org/web-app is removed.')
    expect([remove.mock.calls.length, screen.queryByText('example-org/web-app'), screen.getByText('example-org/api')])
      .toStrictEqual([1, null, expect.anything()])
  })

  it('sends nothing on Cancel, and Escape closes the confirmation', async () => {
    renderConnections({ [LIST]: () => ({ connections: [WEB], limit: 20 }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove example-org/web-app' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect([screen.queryByRole('dialog'), calls('DELETE')]).toStrictEqual([null, []])
    await userEvent.click(screen.getByRole('button', { name: 'Remove example-org/web-app' }))
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
})
