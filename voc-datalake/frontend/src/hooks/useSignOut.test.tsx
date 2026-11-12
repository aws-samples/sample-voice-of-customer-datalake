/**
 * @fileoverview Sign-out drops what the next person must not inherit (the query cache and the current workspace,
 * whose id every API call would otherwise keep sending), then leaves the workspace's address with a full page
 * load to the plain sign-in page.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'
import { stubLocationAssign } from '../test/location'

vi.mock('../services/auth', () => ({ authService: { signOut: vi.fn() } }))

import { authService } from '../services/auth'
import { setCurrentWorkspace, workspaceHeader } from '../workspace/currentWorkspace'
import { ACME } from '../test/workspaceFixtures'
import { refusedWorkspaceIds, rememberRefused } from '../workspace/refusedWorkspaces'
import { useSignOut } from './useSignOut'

describe('useSignOut', () => {
  it('clears the cache and the current workspace, signs out, then loads /login outside the workspace', () => {
    const client = createTestQueryClient()
    client.setQueryData(['my-workspaces'], [ACME])
    setCurrentWorkspace(ACME)
    // What each step had cleared when the page load started.
    const atLoad: unknown[] = []
    stubLocationAssign('/w/acme/account').mockImplementation((url) => {
      atLoad.push(url, client.getQueryData(['my-workspaces']), workspaceHeader('/api/feedback'))
    })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useSignOut(), { wrapper })
    act(() => result.current())
    expect(atLoad).toStrictEqual(['/login', undefined, {}])
    expect(authService.signOut).toHaveBeenCalledExactlyOnceWith()
  })

  it("forgets the tab's refused workspaces, so the next person asks the server afresh", () => {
    rememberRefused(ACME.id)
    stubLocationAssign('/w/acme/account')
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useSignOut(), { wrapper })
    act(() => result.current())
    expect(refusedWorkspaceIds()).toStrictEqual([])
  })
})
