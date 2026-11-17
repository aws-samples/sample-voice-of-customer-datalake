/**
 * @fileoverview Agents → Connections, a connection's CI attestation (CiAttestation.tsx; the row since 7.52.00): its chip
 * on the row and what its details say in each state (none, attested with who and when, withdrawn, voided by a
 * repository change or a removal); Attest CI as the row's one action only while none holds, Withdraw CI attestation…
 * in its "⋯" once one does; recording one only once every point of the setup guide is ticked (the POST with every point
 * and the note), withdrawing one after a confirmation (the DELETE), a server's 409 in its own words; and the whole flow
 * in each of the nine shipped locales.
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
import { at } from '@test/defined'
import { useLocale } from '@test/i18n-locale'
import { sortedStrings } from '@test/stringLists'
import { chooseInRowMenu } from '@test/connectionDialog'
import { ApiError } from '../../lib/errors'
import { CI_POINTS } from '../../api/engineeringConnectionsApi'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringConnections } = await import('./EngineeringConnections')

const LIST = 'GET /agents/engineering/connections'
const ATTEST = 'POST /agents/engineering/connections/web-app/ci-attestation'
const WITHDRAW = 'DELETE /agents/engineering/connections/web-app/ci-attestation'
const REPOSITORY = 'example-org/web-app'
const ATTESTED = {
  version: 1, state: 'attested', repository: REPOSITORY, points: [...CI_POINTS], by: 'admin-a',
  at: '2026-11-14T09:00:00Z', reason: null, cause: null,
}
const WITHDRAWN = { ...ATTESTED, version: 2, state: 'withdrawn' }
/** The connection's version the page shows: what an attestation names as reviewed, with its repository. */
const VERSION = 4
const REVIEWED = { points: [...CI_POINTS], repository: REPOSITORY, version: VERSION }

const connection = (ciAttestation: unknown) => ({
  connection_id: 'web-app', host: 'github', repository: REPOSITORY, default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: '123', installation_id: '456' },
  created_at: '2026-11-01T10:00:00Z', created_by: 'admin-a', updated_at: '2026-11-02T10:00:00Z', updated_by: 'admin-b',
  version: VERSION, ci_attestation: ciAttestation,
})

/** The server's one connection, whose attestation a route handler changes (`stored.set('ci', …)`). */
function storedConnection(attestation: unknown) {
  const stored = new Map<string, unknown>([['ci', attestation]])
  const list = () => ({ connections: [connection(stored.get('ci'))], limit: 20 })
  return { stored, list }
}

/** The server with no attestation yet, and its POST, which records one. */
function attestingServer() {
  const { stored, list } = storedConnection(null)
  const attest = vi.fn((_body: unknown) => {
    stored.set('ci', ATTESTED)
    return { attestation: ATTESTED, created: true, connection_version: VERSION + 1 }
  })
  return { list, attest }
}

function renderConnections(routes: Record<string, RouteHandler>) {
  routeFetchApi({ 'GET /agents/engineering/github-apps': () => ({ apps: [], limit: 5 }), ...routes }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><EngineeringConnections /></TestRouter>, createTestQueryClient())
}

const calls = (method: string) => fetchApi.mock.calls.filter(([, options]) => options?.method === method)
const attestAction = `Attest CI ${REPOSITORY}`
const dialogTitle = `Attest the CI of ${REPOSITORY}`
const row = async () => within(await screen.findByTestId('connection-row-web-app'))

async function openAttest(action = attestAction, title = dialogTitle) {
  await userEvent.click(await screen.findByRole('button', { name: action }))
  return screen.getByRole('dialog', { name: title })
}

async function tickAll(dialog: HTMLElement) {
  for (const box of within(dialog).getAllByRole('checkbox')) await userEvent.click(box)
}

/** What the row's details say of its CI. */
async function detailsText() {
  await userEvent.click(screen.getByRole('button', { name: `Connection details for ${REPOSITORY}` }))
  return screen.getByRole('dialog', { name: 'Connection details' }).textContent
}

beforeEach(() => { resetFetchApi() })

describe('what a connection\'s CI attestation says', () => {
  it.each([
    ['none', null, 'CI not attested', 'The agents push nothing to this repository until an administrator attests'],
    ['attested', ATTESTED, 'CI attested', 'Attested by admin-a'],
    ['withdrawn', { ...WITHDRAWN, by: 'admin-b' }, 'CI not attested', 'Withdrawn by admin-b'],
    ['voided by a repository change', { ...ATTESTED, version: 2, state: 'voided', cause: 'repository_changed' },
      'CI not attested', 'Voided when the connection’s repository changed'],
    ['voided by a removal', { ...ATTESTED, version: 2, state: 'voided', cause: 'connection_removed' },
      'CI not attested', 'Voided when the connection was removed'],
    // A state the page does not know is never read as attested.
    ['a state the page does not know', { ...ATTESTED, state: 'approved' }, 'CI not attested', 'Voided'],
  ])('%s', async (_name, attestation, badge, text) => {
    renderConnections({ [LIST]: () => ({ connections: [connection(attestation)], limit: 20 }) })
    const found = await row()
    expect(found.getByText(badge)).toBeInTheDocument()
    // Attested: no action on the row (withdrawing is in its menu); anything else: Attest CI is its one action.
    const attested = badge === 'CI attested'
    expect(found.queryByRole('button', { name: attestAction }) !== null).toBe(!attested)
    expect(await detailsText()).toContain(text)
  })

  it('offers Withdraw CI attestation… in the row\'s "⋯" once one holds', async () => {
    renderConnections({ [LIST]: () => ({ connections: [connection(ATTESTED)], limit: 20 }) })
    await userEvent.click(await screen.findByRole('button', { name: `Actions for ${REPOSITORY}` }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toStrictEqual(['Edit connection…', 'Withdraw CI attestation…', 'Remove connection…'])
  })
})

describe('recording an attestation', () => {
  it('sends nothing until every point is ticked, and focuses the first one left', async () => {
    renderConnections({ [LIST]: () => ({ connections: [connection(null)], limit: 20 }) })
    const dialog = await openAttest()
    const boxes = within(dialog).getAllByRole('checkbox')
    await userEvent.click(at(boxes, 0))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record attestation' }))
    expect([boxes.length, within(dialog).getByRole('alert').textContent]).toStrictEqual(
      [CI_POINTS.length, 'Confirm every point: the agents push only once all of them hold.'])
    expect(at(boxes, 1)).toHaveFocus()
    expect(at(boxes, 1)).toHaveAttribute('aria-invalid', 'true')
    expect(calls('POST')).toStrictEqual([])
  })

  it('posts every point and the note, then shows the attestation and says so', async () => {
    const { list, attest } = attestingServer()
    renderConnections({ [LIST]: list, [ATTEST]: attest })
    const dialog = await openAttest()
    await tickAll(dialog)
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Checked the runners')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record attestation' }))
    expect(await screen.findByText(`The CI attestation of ${REPOSITORY} is recorded.`)).toHaveAttribute('role', 'status')
    // The repository and version the dialog showed go with it: the server refuses it once either changed.
    expect(attest.mock.calls).toStrictEqual([[{ ...REVIEWED, reason: 'Checked the runners' }]])
    expect([screen.queryByRole('dialog'), await screen.findByText('CI attested')]).toStrictEqual([null, expect.anything()])
    expect(screen.queryByRole('button', { name: attestAction })).not.toBeInTheDocument()
  })

  it('says a server\'s 409 in its own words and stays open; Escape closes it', async () => {
    const reason = 'the connection changed meanwhile: reload it and try again'
    renderConnections({
      [LIST]: () => ({ connections: [connection(null)], limit: 20 }),
      [ATTEST]: () => { throw new ApiError(409, reason) },
    })
    const dialog = await openAttest()
    await tickAll(dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record attestation' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls('POST')).toHaveLength(1)
  })
})

describe('withdrawing an attestation', () => {
  it('asks first, saying what the agents lose, then sends the DELETE with the note typed', async () => {
    const { stored, list } = storedConnection(ATTESTED)
    const withdraw = vi.fn((_body: unknown) => {
      stored.set('ci', WITHDRAWN)
      return { withdrawn: true }
    })
    renderConnections({ [LIST]: list, [WITHDRAW]: withdraw })
    await chooseInRowMenu(`Actions for ${REPOSITORY}`, 'Withdraw CI attestation…')
    const confirm = screen.getByRole('dialog', { name: `Withdraw the CI attestation of ${REPOSITORY}?` })
    expect(confirm).toHaveTextContent(`next push or pull request on ${REPOSITORY} is refused`)
    await userEvent.type(within(confirm).getByLabelText('Note (optional)'), 'A runner was added')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Withdraw attestation' }))
    const withdrawn = await screen.findByText(`The CI attestation of ${REPOSITORY} is withdrawn.`)
    expect([withdrawn.getAttribute('role'), withdraw.mock.calls]).toStrictEqual(['status', [[{ reason: 'A runner was added' }]]])
    expect(await screen.findByRole('button', { name: attestAction })).toBeInTheDocument()
    expect(await detailsText()).toContain('Withdrawn by admin-a')
  })

  it('sends nothing on Cancel', async () => {
    renderConnections({ [LIST]: () => ({ connections: [connection(ATTESTED)], limit: 20 }) })
    await chooseInRowMenu(`Actions for ${REPOSITORY}`, 'Withdraw CI attestation…')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect([screen.queryByRole('dialog'), calls('DELETE')]).toStrictEqual([null, []])
  })
})

// --- the nine shipped locales ---------------------------------------------------------------------------------------

const LOCALES_DIR = path.join(__dirname, '../../../public/locales')
const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'zh'] as const

const ciSchema = z.object({
  attested: z.string(), notAttested: z.string(), attest: z.string(), recorded: z.string(),
  points: z.record(z.string(), z.string()),
  dialog: z.object({ title: z.string(), save: z.string(), allPoints: z.string() }),
})
const bundleSchema = z.object({ connections: z.object({ ci: ciSchema }) }).loose()

const agentsBundle = (locale: string) =>
  bundleSchema.parse(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'agents.json'), 'utf8')))

const named = (text: string) => text.replace('{{repository}}', REPOSITORY)

describe.each(LOCALES)('the CI attestation in %s', (locale) => {
  const bundle = agentsBundle(locale)
  const { ci } = bundle.connections
  useLocale(locale, { agents: bundle })

  it('names every point of the setup guide, each in the locale\'s words', () => {
    expect(sortedStrings(Object.keys(ci.points))).toStrictEqual(sortedStrings(CI_POINTS))
    expect(CI_POINTS.filter((point) => (ci.points[point] ?? '').trim() === '')).toStrictEqual([])
  })

  it('records an attestation through the locale\'s own labels', async () => {
    const { list, attest } = attestingServer()
    renderConnections({ [LIST]: list, [ATTEST]: attest })
    expect((await row()).getByText(ci.notAttested)).toBeInTheDocument()
    const dialog = await openAttest(`${ci.attest} ${REPOSITORY}`, named(ci.dialog.title))
    await userEvent.click(within(dialog).getByRole('button', { name: ci.dialog.save }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(ci.dialog.allPoints)
    for (const point of CI_POINTS) {
      await userEvent.click(within(dialog).getByRole('checkbox', { name: ci.points[point] }))
    }
    await userEvent.click(within(dialog).getByRole('button', { name: ci.dialog.save }))
    expect(await screen.findByText(named(ci.recorded))).toHaveAttribute('role', 'status')
    expect([attest.mock.calls, await screen.findByText(ci.attested)]).toStrictEqual([[[REVIEWED]], expect.anything()])
  })
})
