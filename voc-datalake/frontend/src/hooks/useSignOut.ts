/**
 * @fileoverview Sign-out shared by the sidebar and the Account page.
 * @module hooks/useSignOut
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authService } from '../services/auth'
import { setCurrentWorkspace } from '../workspace/currentWorkspace'
import { forgetPlatformEntries } from '../workspace/platformEntry'
import { forgetRefused } from '../workspace/refusedWorkspaces'

/** Where a voluntary sign-out lands: the plain sign-in page, outside any `/w/{slug}` (docs/multi-workspace.md). */
const SIGNED_OUT_PATH = '/login'

export function useSignOut(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    // The cache and the current workspace are cleared first, so nothing renders or is sent for the last person
    // while the page unloads; the full page load then drops every in-memory cache and in-flight request, and
    // leaves the workspace's address (the router's basename would keep `/w/{slug}` on an in-app navigation).
    queryClient.clear()
    setCurrentWorkspace(null)
    forgetRefused()
    forgetPlatformEntries()
    authService.signOut()
    window.location.assign(SIGNED_OUT_PATH)
  }, [queryClient])
}
