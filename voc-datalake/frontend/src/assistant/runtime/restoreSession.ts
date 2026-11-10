/**
 * @fileoverview After a full page load the open conversations are gone from
 * memory: bring back the one that was in view (`activeThreadId`, persisted).
 *
 * It starts when the app shell mounts (AssistantRoot, on every route), not when
 * the panel opens: the panel used to start it on open, so a message typed while
 * the saved conversation was still loading went into the fresh, empty one, and
 * when the load landed it replaced the view — the answer seemed to vanish and
 * the next message went back to the old conversation (live 5.14 finding).
 *
 * While it loads the composer is closed (`restore.status === 'pending'`), and
 * any explicit choice — New conversation, picking a conversation — settles the
 * ticket, after which the load never takes the view over. A session that no
 * longer exists is forgotten; a failed read keeps the id for the next load.
 *
 * @module assistant/runtime/restoreSession
 */
import { useEffect, useRef } from 'react'
import { getSession } from '../sessions/sessionsApi'
import { RESTORE_DONE, slotOf, useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { showLoadedSession } from './runtime'
import type { RestoreTicket } from '../store/assistantStore'
import type { RunEnvironment } from './runtime'
import type { SessionRecord } from '../sessions/schema'

async function readSaved(id: string): Promise<SessionRecord | null | 'unavailable'> {
  try {
    return await getSession(id)
  } catch {
    return 'unavailable'
  }
}

/** The id to bring back, or null when there is nothing to restore. */
function restorableId(): string | null {
  const id = useAssistantUiStore.getState().activeThreadId
  const { thread, slots } = useThreadStore.getState()
  if (id === null || thread.messages.length > 0 || slotOf(slots, id) !== undefined) return null
  return id
}

/** Once per sign-in (the store's ticket starts `idle` and a sign-out resets it). */
async function restoreLastSession(env: RunEnvironment): Promise<void> {
  const store = useThreadStore.getState()
  if (store.restore.status !== 'idle') return
  const id = restorableId()
  if (id === null) {
    store.setRestore(RESTORE_DONE)
    return
  }
  const ticket: RestoreTicket = { status: 'pending' }
  store.setRestore(ticket)
  const placeholderId = store.activeId
  const record = await readSaved(id)
  // Settled meanwhile (the user chose a conversation, or signed out): leave the view alone.
  if (useThreadStore.getState().restore !== ticket) return
  useThreadStore.getState().setRestore(RESTORE_DONE)
  if (record === 'unavailable') return
  if (record === null) {
    useAssistantUiStore.getState().setActiveThreadId(null)
    return
  }
  const now = useThreadStore.getState()
  if (now.activeId !== placeholderId || now.thread.messages.length > 0) return
  showLoadedSession(record, env)
}

/** Start the restore once, when the app shell mounts (with the environment of that first render). */
export function useRestoreLastSession(env: RunEnvironment): void {
  const envRef = useRef(env)
  useEffect(() => {
    void restoreLastSession(envRef.current)
  }, [])
}
