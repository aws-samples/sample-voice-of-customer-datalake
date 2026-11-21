/**
 * The caller's workspaces client: the wire paths of workspaces_handler.py and the lenient read (a row this
 * build cannot read is left out; an unreadable answer is no workspace).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { readMyWorkspaces, workspacesApi } from './workspacesApi'
import { ACME, JUNIPER } from '../test/workspaceFixtures'

beforeEach(() => resetFetchApi())

describe('readMyWorkspaces', () => {
  it('keeps the readable rows in the server\'s order', () => {
    const juniper = { ...JUNIPER, role: 'viewer' }
    expect(readMyWorkspaces({ workspaces: [ACME, juniper] })).toStrictEqual([ACME, juniper])
  })

  it('leaves out a row with an unknown role, a slug that cannot be a base path or a missing field', () => {
    const rows = [{ ...ACME, role: 'owner' }, { ...ACME, slug: 'Bad Slug' }, { ...ACME, slug: 'admin' }, { name: 'x' }, 'junk', ACME]
    expect(readMyWorkspaces({ workspaces: rows })).toStrictEqual([ACME])
  })

  it.each([[null], [{}], [{ workspaces: 'none' }], ['nope']])('reads %j as no workspace', (raw) => {
    expect(readMyWorkspaces(raw)).toStrictEqual([])
  })
})

describe('workspacesApi', () => {
  it('lists GET /me/workspaces', async () => {
    routeFetchApi({ 'GET /me/workspaces': () => ({ workspaces: [ACME] }) })
    await expect(workspacesApi.list()).resolves.toStrictEqual([ACME])
  })

  it('reads GET /me/workspaces/current as the workspace, without platform_admin', async () => {
    routeFetchApi({ 'GET /me/workspaces/current': () => ({ workspace: { ...ACME, platform_admin: true } }) })
    await expect(workspacesApi.current()).resolves.toStrictEqual({ ...ACME, trial: null, playbook: null })
  })

  // 7.71.00: a trial workspace's state and the playbook suggested to the caller, read leniently.
  it('reads its trial and the suggested playbook, and reads anything else as none', async () => {
    const trial = { days: 14, expires_at: '2026-12-05T09:00:00+00:00', paused_at: null, converted_at: null, paused: null }
    routeFetchApi({ 'GET /me/workspaces/current': () => ({ workspace: { ...ACME, trial, playbook: 'qa' } }) })
    await expect(workspacesApi.current()).resolves.toStrictEqual({ ...ACME, trial, playbook: 'qa' })
    routeFetchApi({ 'GET /me/workspaces/current': () => ({ workspace: { ...ACME, trial: 'soon', playbook: 'ceo' } }) })
    await expect(workspacesApi.current()).resolves.toStrictEqual({ ...ACME, trial: null, playbook: null })
  })

  it('rejects with the API\'s 404 for a workspace the caller cannot enter', async () => {
    routeFetchApi({})
    await expect(workspacesApi.current()).rejects.toThrow('404')
  })
})
