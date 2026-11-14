/**
 * @fileoverview What an open tab does when another tab of this browser signs out, or its session expires.
 *
 * The signal is a record written only where a session really ends: the sign-out (hooks/useSignOut.ts) and an expired
 * session (services/sessionExpiry.ts) call {@link announceSessionEnded}, which sets `voc-session-ended` in
 * localStorage to a fresh value, and the browser tells every other tab of the origin with a `storage` event. Not the
 * session's own record (`voc-auth`): it is also written signed out when a refresh fails for a moment (a brief network
 * failure) and the retry signs the tab back in, which must not end every other tab. A tab never hears its own writes,
 * so the tab that signed out is left to its own sign-out.
 *
 * On the signal a tab does what its own sign-out would: it forgets every workspace's saved records, the refused
 * list and a platform admin's console entries (workspace/workspaceStorage.ts, workspace/refusedWorkspaces.ts,
 * workspace/platformEntry.ts) and, when it is signed in, leaves with a full page load to the plain `/login`. On a
 * public page (publicRoutes.ts: a ballot, the feedback boards, a shared review, an unsubscribe, the sign-in page
 * itself), which opens without a session of the app, the full load is of the same page instead, so the person stays
 * where they are and the page opens without the app's session. The full load is what stops its three persisted stores from writing
 * the last person's conversation in view, draft or filters back: they live in this page load's memory, and a store
 * writes on every change. It also drops every in-memory cache and in-flight request and the page load's copy of the
 * session, as the app's own sign-out does. `replace`: the page left can no longer load its data.
 *
 * It writes nothing to the session's record, and acts only while the stored session is still signed out: a late
 * signal, after a person signed in meanwhile in another tab, neither clears what they have saved nor reloads a tab.
 * So a tab that ends its session writes `voc-auth` signed out before it announces the end: both callers do, and
 * sessionEndOrder.test.ts fails if either order flips.
 *
 * The listener is installed when this module loads; main.tsx imports it for that (build/bootGraph.test.ts).
 *
 * @module services/crossTabSignOut
 */
import { z } from 'zod'
import { isPublicPath } from '../publicRoutes'
import { useAuthStore } from '../store/authStore'
import { forgetPlatformEntries } from '../workspace/platformEntry'
import { forgetRefused } from '../workspace/refusedWorkspaces'
import { appPathname } from '../workspace/workspacePath'
import { forgetWorkspaceStores } from '../workspace/workspaceStorage'

/** The localStorage key whose every new value says "a session of this browser ended". */
export const SESSION_ENDED_KEY = 'voc-session-ended'

/** Where a tab whose session ended in another tab lands: the plain sign-in page, as after a sign-out. */
const SIGNED_OUT_PATH = '/login'

/** The part of the session's persisted record (store/authStore.ts) that says signed in. */
const SignedInRecord = z.object({ state: z.object({ isAuthenticated: z.literal(true) }) })

/** Whether the session's record as stored now says signed in; a missing, blocked or unreadable one does not. */
function storedSessionSignedIn(): boolean {
  try {
    const record = window.localStorage.getItem(useAuthStore.persist.getOptions().name ?? '')
    return record !== null && SignedInRecord.safeParse(JSON.parse(record)).success
  } catch {
    return false
  }
}

/** Tell the browser's other tabs that this session ended (sign-out, an expired session). */
export function announceSessionEnded(): void {
  try {
    window.localStorage.setItem(SESSION_ENDED_KEY, crypto.randomUUID())
  } catch {
    // Storage blocked (a privacy mode): no tab saved anything there to forget.
  }
}

function onStorage(event: StorageEvent): void {
  if (event.key !== SESSION_ENDED_KEY || event.newValue === null || event.storageArea !== window.localStorage) return
  // A late signal: someone signed in since, and that session is the one the browser holds now.
  if (storedSessionSignedIn()) return
  forgetRefused()
  forgetPlatformEntries()
  forgetWorkspaceStores()
  if (!useAuthStore.getState().isAuthenticated) return
  // A public page opens without a session of the app, so it is reloaded where it is; the boards and a review use the
  // session when there is one, so this page load's copy of it must go all the same.
  if (isPublicPath(appPathname())) window.location.reload()
  else window.location.replace(SIGNED_OUT_PATH)
}

window.addEventListener('storage', onStorage)
