/**
 * The workspace's export client: the wire paths of workspaces_handler.py, the lenient read of the status, and when
 * the status is still being made (the only time it is polled).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { isExportRunning, readWorkspaceExport, workspaceExportApi } from './workspaceExportApi'

const COMPLETED = {
  id: 'ex_01JCACME0000000000000000A1', status: 'completed', created_at: '2026-11-13T09:00:00Z',
  completed_at: '2026-11-13T09:05:00Z', expires_at: '2026-11-20T09:05:00Z', size_bytes: 1234,
}
const EXPORT = '/me/workspaces/current/export'

beforeEach(() => resetFetchApi())

describe('readWorkspaceExport', () => {
  it('reads the newest export, an unknown status as failed', () => {
    expect(readWorkspaceExport({ export: COMPLETED })).toStrictEqual(COMPLETED)
    expect(readWorkspaceExport({ export: { ...COMPLETED, status: 'paused' } })?.status).toBe('failed')
  })

  it.each([[{ export: null }], [null], [{}], [{ export: { status: 'queued' } }]])('reads %j as no export', (raw) => {
    expect(readWorkspaceExport(raw)).toBeNull()
  })
})

describe('isExportRunning', () => {
  it.each([['queued', true], ['running', true], ['completed', false], ['failed', false], ['expired', false], ['erased', false]] as const)(
    '%s → %s', (status, running) => {
      expect(isExportRunning(status)).toBe(running)
    })
})

describe('workspaceExportApi', () => {
  it('reads the status and starts an export with the paths the server routes', async () => {
    routeFetchApi({
      [`GET ${EXPORT}`]: () => ({ export: COMPLETED }),
      [`POST ${EXPORT}`]: () => ({ export: { id: 'ex_2', status: 'queued', created_at: '2026-11-13T10:00:00Z' } }),
    })
    await expect(workspaceExportApi.status()).resolves.toMatchObject({ id: COMPLETED.id, status: 'completed' })
    await expect(workspaceExportApi.start()).resolves.toMatchObject({ id: 'ex_2', status: 'queued' })
    expect(fetchApi).toHaveBeenCalledWith(EXPORT, { method: 'POST', body: '{}' })
  })

  it('asks for a fresh link of the newest export', async () => {
    routeFetchApi({
      [`POST ${EXPORT}/link`]: () => ({ link: { id: COMPLETED.id, url: 'https://example.com/x.zip', expires_in: 900, expires_at: 'z' } }),
    })
    await expect(workspaceExportApi.link()).resolves.toStrictEqual({ id: COMPLETED.id, url: 'https://example.com/x.zip', expires_in: 900 })
    expect(fetchApi).toHaveBeenCalledWith(`${EXPORT}/link`, { method: 'POST', body: '{}' })
  })
})
