/**
 * @fileoverview The query cache belongs to one signed-in user.
 *
 * Every cached answer is the caller's own view (category and source access,
 * private projects, their conversations), and the QueryClient outlives an
 * in-app sign-out and sign-in. So whenever the signed-in user goes away or
 * changes — sign-out from any path (sidebar, Account, a failed refresh in
 * services/auth.ts), or a different user signing in on the same tab — the whole
 * cache is dropped, and a second user never sees the first user's data while
 * their own loads. `useSignOut` also clears explicitly; clearing twice is free.
 *
 * Signing in from signed-out clears nothing (the cache was cleared on the way
 * out), and a session refresh for the same user is not a change.
 *
 * @module api/userCacheScope
 */
import type { QueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import type { User } from '../store/authStore'

/** The stable identity of a user: Cognito `sub`, else the username (sessions persisted before `sub`). */
function userIdentity(user: User | null): string | null {
  if (user === null) return null
  return user.sub ?? user.username
}

/** Clear `queryClient` whenever the signed-in identity leaves or changes; returns the unsubscribe. */
export function bindQueryCacheToUser(queryClient: QueryClient): () => void {
  return useAuthStore.subscribe((state, previous) => {
    const before = userIdentity(previous.user)
    if (before !== null && userIdentity(state.user) !== before) queryClient.clear()
  })
}
