/**
 * The workspace's plugins client: the wire paths of workspaces_handler.py, the lenient read of the list, and the
 * change's answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { readWorkspacePlugins, workspacePluginsApi } from './workspacePluginsApi'

const ON = { id: 'github_issues', enabled: true, enabled_at: '2026-11-01T09:00:00Z', enabled_by: 'sub-ada' }
const OFF = { id: 'webscraper', enabled: false }

beforeEach(() => resetFetchApi())

describe('readWorkspacePlugins', () => {
  it("keeps the readable rows in the server's order", () => {
    expect(readWorkspacePlugins({ plugins: [OFF, ON] })).toStrictEqual([OFF, ON])
  })

  it('leaves out a row with no id or a state that is not a boolean; a bad stamp reads as none', () => {
    const rows = [{ id: '', enabled: false }, { id: 'x', enabled: 'yes' }, 'junk', { ...OFF, enabled_at: 7 }]
    expect(readWorkspacePlugins({ plugins: rows })).toStrictEqual([{ ...OFF, enabled_at: undefined }])
  })

  it.each([[null], [{}], [{ plugins: 'none' }]])('reads %j as no plugin', (raw) => {
    expect(readWorkspacePlugins(raw)).toStrictEqual([])
  })
})

describe('workspacePluginsApi', () => {
  it('lists GET /me/workspaces/current/plugins', async () => {
    routeFetchApi({ 'GET /me/workspaces/current/plugins': () => ({ plugins: [OFF] }) })
    await expect(workspacePluginsApi.list()).resolves.toStrictEqual([OFF])
  })

  it('changes one with PUT …/plugins/{id} {enabled}, and answers the plugin', async () => {
    routeFetchApi({ 'PUT /me/workspaces/current/plugins/webscraper': () => ({ plugin: OFF }) })
    await expect(workspacePluginsApi.setEnabled('webscraper', false)).resolves.toStrictEqual(OFF)
    expect(fetchApi).toHaveBeenCalledWith('/me/workspaces/current/plugins/webscraper', { method: 'PUT', body: '{"enabled":false}' })
  })
})
