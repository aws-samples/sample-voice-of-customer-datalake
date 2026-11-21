/**
 * @fileoverview Who may import (useCanImport.ts): the deployment's admins outside a workspace; inside one its admins
 * only, whatever the deployment's group says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

interface State { isAdmin: boolean; workspace: { slug: string } | null; role: string | null }
const state: State = { isAdmin: false, workspace: null, role: null }
vi.mock('../../../store/authStore', () => ({ useIsAdmin: () => state.isAdmin }))
vi.mock('../../../workspace/currentWorkspace', () => ({ useCurrentWorkspace: () => state.workspace }))
vi.mock('../../../workspace/useMyWorkspaces', () => ({ useServerRole: () => state.role }))
import { useCanImport } from './useCanImport'

describe('useCanImport', () => {
  beforeEach(() => {
    Object.assign(state, { isAdmin: false, workspace: null, role: null })
  })

  it("is the deployment's admins outside a workspace", () => {
    expect(renderHook(() => useCanImport()).result.current).toBe(false)
    state.isAdmin = true
    expect(renderHook(() => useCanImport()).result.current).toBe(true)
  })

  it("is a workspace's admins inside it, not the deployment's group", () => {
    Object.assign(state, { isAdmin: true, workspace: { slug: 'a' }, role: 'editor' })
    expect(renderHook(() => useCanImport()).result.current).toBe(false)
    Object.assign(state, { isAdmin: false, role: 'admin' })
    expect(renderHook(() => useCanImport()).result.current).toBe(true)
  })
})
