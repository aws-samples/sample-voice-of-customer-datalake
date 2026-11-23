/**
 * The platform console's client: `GET` and `POST /platform/workspaces` as workspaces_handler.py answers them, and
 * the lenient read (a slug that could not be a base path is left out; the answers' `secret_status`, always `ready`
 * since decision 19, is not read).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_ACME as ACME } from '../test/workspaceFixtures'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { platformWorkspacesApi, toTrialDays } from './platformWorkspacesApi'

beforeEach(() => resetFetchApi())

/** `list(null)` of the answer `body`. */
function listOf(body: unknown) {
  routeFetchApi({ 'GET /platform/workspaces': () => body })
  return platformWorkspacesApi.list(null)
}

describe('platformWorkspacesApi.list', () => {
  it('keeps the readable rows, without the secret status the server still sends', async () => {
    await expect(listOf({ workspaces: [{ ...ACME, secret_status: 'ready' }, { ...ACME, slug: 'acme-two' }], next_cursor: 'n' })).resolves.toStrictEqual({
      rows: [{ ...ACME, trial: null }, { ...ACME, slug: 'acme-two', trial: null }],
      nextCursor: 'n',
    })
  })

  it('leaves out a slug that could not be a base path, and reads junk as no workspace', async () => {
    await expect(listOf({ workspaces: [{ ...ACME, slug: 'www' }, { name: 'x' }] })).resolves.toStrictEqual({ rows: [], nextCursor: null })
    await expect(listOf(null)).resolves.toStrictEqual({ rows: [], nextCursor: null })
  })

  it('reads a later page by its cursor', async () => {
    routeFetchApi({ 'GET /platform/workspaces?cursor=k': () => ({ workspaces: [], next_cursor: null }) })
    await expect(platformWorkspacesApi.list('k')).resolves.toStrictEqual({ rows: [], nextCursor: null })
  })
})

describe('platformWorkspacesApi.create', () => {
  it('creates one with its name and slug', async () => {
    routeFetchApi({ 'POST /platform/workspaces': () => ({ workspace: { id: ACME.id, name: ACME.name, slug: 'acme', role: 'admin', secret_status: 'ready' } }) })
    await expect(platformWorkspacesApi.create('Acme Outfitters', 'acme')).resolves.toStrictEqual({
      id: ACME.id, name: 'Acme Outfitters', slug: 'acme',
    })
    expect(fetchApi).toHaveBeenCalledWith('/platform/workspaces', { method: 'POST', body: '{"name":"Acme Outfitters","slug":"acme"}' })
  })
})

// 7.71.00: a trial workspace's create, extension and conversion (docs/multi-workspace.md "Trial workspaces").
describe('platformWorkspacesApi trials', () => {
  const VIEW = { days: 30, expires_at: '2026-12-21T09:00:00+00:00', paused_at: null, converted_at: null, extended: [] }

  it('creates a trial with its days and pack', async () => {
    routeFetchApi({ 'POST /platform/workspaces': () => ({ workspace: { ...ACME, trial: VIEW } }) })
    const pack = { forms: ['workshop'], categories: true, playbooks: false }
    await expect(platformWorkspacesApi.createTrial('Acme Outfitters', 'acme', 60, pack))
      .resolves.toStrictEqual({ id: ACME.id, name: ACME.name, slug: ACME.slug })
    expect(sentFetchApiBody('/platform/workspaces', 'POST')).toStrictEqual({ name: 'Acme Outfitters', slug: 'acme', trial: { days: 60, pack } })
  })

  it('extends by its days and converts, each answering the trial and what it resumed', async () => {
    const resumed = { plugins: 1, forms: 0, skipped: [{ form_id: 'ff_1', name: 'Workshop', code: 'theme_unreadable' }] }
    routeFetchApi({
      [`POST /platform/workspaces/${ACME.id}/trial/extend`]: () => ({ trial: VIEW }),
      [`POST /platform/workspaces/${ACME.id}/trial/convert`]: () => ({ trial: { ...VIEW, converted_at: '2026-12-01T09:00:00+00:00', resumed } }),
    })
    await expect(platformWorkspacesApi.extendTrial(ACME.id, 14)).resolves.toStrictEqual({ ...VIEW, resumed: null })
    expect(sentFetchApiBody(`/platform/workspaces/${ACME.id}/trial/extend`, 'POST')).toStrictEqual({ days: 14 })
    await expect(platformWorkspacesApi.convertTrial(ACME.id)).resolves.toMatchObject({ converted_at: '2026-12-01T09:00:00+00:00', resumed })
  })

  it('reads a length from a select, the default for anything else', () => {
    expect([toTrialDays('14'), toTrialDays(60), toTrialDays('45'), toTrialDays(null)]).toStrictEqual([14, 60, 30, 30])
  })
})
