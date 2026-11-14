/**
 * @fileoverview Who may edit the brand: the deployment's `admins` outside a workspace, the workspace's admins (the
 * server's role there) inside one, as `PUT /settings/brand` decides it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createQueryWrapper } from '../../test/query-client'
import { ACME, JUNIPER } from '../../test/workspaceFixtures'
import { setCurrentWorkspace, type CurrentWorkspace } from '../../workspace/currentWorkspace'
import { workspacesApi } from '../../api/workspacesApi'
import { useBrandEditRight } from './useBrandEditRight'

function render(isDeploymentAdmin: boolean, workspace: CurrentWorkspace | null) {
  act(() => setCurrentWorkspace(workspace))
  return renderHook(() => useBrandEditRight(isDeploymentAdmin), { wrapper: createQueryWrapper() })
}

afterEach(() => {
  setCurrentWorkspace(null)
  vi.restoreAllMocks()
})

describe('useBrandEditRight', () => {
  it.each([[true, true], [false, false]])('outside a workspace follows the deployment admins (%s -> %s)', (admin, shown) => {
    const current = vi.spyOn(workspacesApi, 'current')
    expect(render(admin, null).result.current).toBe(shown)
    expect(current).not.toHaveBeenCalled()
  })

  it('inside a workspace is true for its admin, also outside the deployment admins', async () => {
    vi.spyOn(workspacesApi, 'current').mockResolvedValue(ACME)
    const { result } = render(false, ACME)
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('inside a workspace is false for an editor there, even in the deployment admins', async () => {
    const current = vi.spyOn(workspacesApi, 'current').mockResolvedValue(JUNIPER)
    const { result } = render(true, JUNIPER)
    await waitFor(() => expect(current).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('takes the role the server applies over the membership row', async () => {
    vi.spyOn(workspacesApi, 'current').mockResolvedValue({ ...JUNIPER, role: 'admin' })
    const { result } = render(false, JUNIPER)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('keeps the membership role when the server read fails', async () => {
    vi.spyOn(workspacesApi, 'current').mockRejectedValue(new Error('offline'))
    const { result } = render(false, ACME)
    await waitFor(() => expect(result.current).toBe(true))
  })
})
