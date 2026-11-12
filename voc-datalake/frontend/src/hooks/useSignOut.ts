/**
 * @fileoverview Sign-out shared by the sidebar and the Account page.
 * @module hooks/useSignOut
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authService } from '../services/auth'
import { announceSessionEnded } from '../services/crossTabSignOut'
import { setCurrentWorkspace } from '../workspace/currentWorkspace'
import { forgetPlatformEntries } from '../workspace/platformEntry'
import { forgetRefused } from '../workspace/refusedWorkspaces'
import { forgetWorkspaceStores } from '../workspace/workspaceStorage'

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
    forgetWorkspaceStores()
    // The browser's other open tabs end theirs too (services/crossTabSignOut.ts).
    announceSessionEnded()
    window.location.assign(SIGNED_OUT_PATH)
  }, [queryClient])
}
