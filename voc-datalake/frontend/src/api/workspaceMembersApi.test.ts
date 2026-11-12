/**
 * The members client: the wire paths and bodies of workspaces_handler.py, the cursor of a later page, and the
 * lenient read (a row this build cannot read is left out; a missing email or name reads as empty).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { workspaceMembersApi, workspaceMembersKey } from './workspaceMembersApi'

const ADA = { sub: 'sub-admin-demo', role: 'admin', email: 'admin@example.com', name: 'Ada Admin', invited_by: '', joined_at: '2026-10-13T09:00:00Z' }

beforeEach(() => resetFetchApi())

/** `list(null)` of the answer `body`. */
function listOf(body: unknown) {
  routeFetchApi({ 'GET /me/workspaces/current/members': () => body })
  return workspaceMembersApi.list(null)
}

describe('workspaceMembersApi.list reads leniently', () => {
  it('keeps the readable rows in order, with the next cursor', async () => {
    const erased = { sub: 'sub-erased', role: 'viewer', email: null, joined_at: '2026-10-20T09:00:00Z' }
    await expect(listOf({ members: [ADA, erased], next_cursor: 'abc' })).resolves.toStrictEqual({
      rows: [
        { sub: 'sub-admin-demo', role: 'admin', email: 'admin@example.com', name: 'Ada Admin', joined_at: '2026-10-13T09:00:00Z' },
        { sub: 'sub-erased', role: 'viewer', email: '', name: '', joined_at: '2026-10-20T09:00:00Z' },
      ],
      nextCursor: 'abc',
    })
  })

  it('leaves out a row with an unknown role or no sub, and reads junk as an empty last page', async () => {
    await expect(listOf({ members: [{ ...ADA, role: 'owner' }, { role: 'viewer' }, 'junk'], next_cursor: null }))
      .resolves.toStrictEqual({ rows: [], nextCursor: null })
    await expect(listOf('nope')).resolves.toStrictEqual({ rows: [], nextCursor: null })
  })
})

describe('workspaceMembersApi', () => {
  it('lists the first page, then a later one by its cursor', async () => {
    routeFetchApi({
      'GET /me/workspaces/current/members': () => ({ members: [ADA], next_cursor: 'c 1' }),
      'GET /me/workspaces/current/members?cursor=c+1': () => ({ members: [], next_cursor: null }),
    })
    await expect(workspaceMembersApi.list(null)).resolves.toMatchObject({ nextCursor: 'c 1' })
    await expect(workspaceMembersApi.list('c 1')).resolves.toStrictEqual({ rows: [], nextCursor: null })
  })

  it('adds by email and role, and reads whether the account was created', async () => {
    routeFetchApi({ 'POST /me/workspaces/current/members': () => ({ member: { ...ADA, role: 'viewer', account: 'created' } }) })
    await expect(workspaceMembersApi.add('admin@example.com', 'viewer')).resolves.toMatchObject({ role: 'viewer', account: 'created' })
    expect(fetchApi).toHaveBeenCalledWith('/me/workspaces/current/members', { method: 'POST', body: '{"email":"admin@example.com","role":"viewer"}' })
  })

  it('changes a role and removes a member by their sub', async () => {
    routeFetchApi({
      'PUT /me/workspaces/current/members/sub-a': () => ({ member: { sub: 'sub-a', role: 'editor' } }),
      'DELETE /me/workspaces/current/members/sub-a': () => ({ removed: 'sub-a' }),
    })
    await workspaceMembersApi.changeRole('sub-a', 'editor')
    await workspaceMembersApi.remove('sub-a')
    expect(fetchApi.mock.calls).toStrictEqual([
      ['/me/workspaces/current/members/sub-a', { method: 'PUT', body: '{"role":"editor"}' }],
      ['/me/workspaces/current/members/sub-a', { method: 'DELETE' }],
    ])
  })

  it('keys the list per workspace under the caller\'s workspaces', () => {
    expect(workspaceMembersKey('ws_1')).toStrictEqual(['my-workspaces', 'members', 'ws_1'])
  })
})
