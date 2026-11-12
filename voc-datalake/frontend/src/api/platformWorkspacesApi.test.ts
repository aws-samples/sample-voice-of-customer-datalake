/**
 * The platform console's client: `GET` and `POST /platform/workspaces` as workspaces_handler.py answers them, and
 * the lenient read (an unknown secret status is pending, a slug that could not be a base path is left out).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_ACME as ACME } from '../test/workspaceFixtures'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { platformWorkspacesApi } from './platformWorkspacesApi'

beforeEach(() => resetFetchApi())

/** `list(null)` of the answer `body`. */
function listOf(body: unknown) {
  routeFetchApi({ 'GET /platform/workspaces': () => body })
  return platformWorkspacesApi.list(null)
}

describe('platformWorkspacesApi.list', () => {
  it('keeps the readable rows, an unknown secret status read as pending', async () => {
    await expect(listOf({ workspaces: [ACME, { ...ACME, slug: 'acme-two', secret_status: 'maybe' }], next_cursor: 'n' })).resolves.toStrictEqual({
      rows: [ACME, { ...ACME, slug: 'acme-two', secret_status: 'pending' }],
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
  it('creates one with its name and slug, and reads the secret status', async () => {
    routeFetchApi({ 'POST /platform/workspaces': () => ({ workspace: { id: ACME.id, name: ACME.name, slug: 'acme', role: 'admin', secret_status: 'pending' } }) })
    await expect(platformWorkspacesApi.create('Acme Outfitters', 'acme')).resolves.toStrictEqual({
      id: ACME.id, name: 'Acme Outfitters', slug: 'acme', secret_status: 'pending',
    })
    expect(fetchApi).toHaveBeenCalledWith('/platform/workspaces', { method: 'POST', body: '{"name":"Acme Outfitters","slug":"acme"}' })
  })
})
