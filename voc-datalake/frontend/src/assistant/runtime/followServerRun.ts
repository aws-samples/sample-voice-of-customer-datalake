/**
 * @fileoverview Following an answer the SERVER is still generating.
 *
 * The stream Lambda saves the conversation while a run streams (user turn +
 * the in-progress answer, `runStatus: 'running'`) and keeps running when the
 * tab goes away. A reload mid-answer, or a stream cut by the network, finds
 * that record: the thread comes back `generating` with the partial answer, and
 * this module polls `GET /chat/conversations/{id}` with backoff until the
 * stored run is no longer running (finished / failed / interrupted, or dead —
 * see `isLiveServerRun`) or {@link FOLLOW_BOUND_MS} passes; each poll replaces
 * the thread with the newer record. One follower per thread at most.
 *
 * The server owns a run's answer: `adoptServerSession` is also what a save
 * refused with 409 (the server has a newer revision) falls back to.
 *
 * @module assistant/runtime/followServerRun
 */
import { STALE_RUN_SECONDS } from '../contract'
import { getSession } from '../sessions/sessionsApi'
import { isLiveServerRun } from '../sessions/schema'
import { threadFromSession } from '../sessions/serialize'
import { slotOf, useThreadStore } from '../store/assistantStore'
import type { SessionRecord } from '../sessions/schema'

/** Poll delays: quick at first (an answer usually finishes within seconds), then every 5 s. */
const STEADY_DELAY_MS = 5000
const FOLLOW_DELAYS_MS = [1000, 2000, 3000, STEADY_DELAY_MS] as const
/** Stop following after this long: by then the server run has finished or died. */
export const FOLLOW_BOUND_MS = STALE_RUN_SECONDS * 1000
export const FOLLOW_TIMEOUT_CODE = 'SERVER_RUN_TIMEOUT'

const following = new Set<string>()

function delayFor(attempt: number): number {
  return FOLLOW_DELAYS_MS.at(attempt) ?? STEADY_DELAY_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function statusOf(threadId: string): string | undefined {
  return slotOf(useThreadStore.getState().slots, threadId)?.thread.status
}

/** Put a stored record into its open thread (never into one this tab is streaming). */
function applyRecord(threadId: string, record: SessionRecord): void {
  if (statusOf(threadId) === 'streaming') return
  const store = useThreadStore.getState()
  store.dispatchTo(threadId, { type: 'local/restore', state: threadFromSession(record) })
  store.setRevision(threadId, record.revision)
}

async function readSession(threadId: string): Promise<SessionRecord | null | 'unavailable'> {
  try {
    return await getSession(threadId)
  } catch {
    // A failed poll is retried on the next tick; the bound still applies.
    return 'unavailable'
  }
}

/**
 * Poll until the server's run for `threadId` ends. Stops on its own when the
 * thread is closed or leaves `generating` (a sign-out resets every thread).
 */
export async function followServerRun(threadId: string): Promise<void> {
  if (following.has(threadId)) return
  following.add(threadId)
  try {
    await pollUntilDone(threadId, Date.now(), 0)
  } finally {
    following.delete(threadId)
  }
}

/** One poll, then the next after its backoff delay (recursion: the attempt counter stays const). */
async function pollUntilDone(threadId: string, started: number, attempt: number): Promise<void> {
  if (Date.now() - started >= FOLLOW_BOUND_MS) {
    if (statusOf(threadId) === 'generating') {
      useThreadStore.getState().dispatchTo(threadId, {
        type: 'local/failed', error: { message: 'timeout', code: FOLLOW_TIMEOUT_CODE },
      })
    }
    return
  }
  await sleep(delayFor(attempt))
  if (statusOf(threadId) !== 'generating') return
  const record = await readSession(threadId)
  if (record === null) {
    useThreadStore.getState().dispatchTo(threadId, { type: 'local/failed', error: { message: 'not_found' } })
    return
  }
  if (record !== 'unavailable') {
    applyRecord(threadId, record)
    if (!isLiveServerRun(record)) return
  }
  await pollUntilDone(threadId, started, attempt + 1)
}

/**
 * The server holds a newer revision of an open conversation (its save was
 * refused with 409): load it, and follow it when the server is still
 * generating. A thread this tab is streaming is left alone.
 */
export async function adoptServerSession(threadId: string): Promise<void> {
  if (statusOf(threadId) === undefined || statusOf(threadId) === 'streaming') return
  const record = await readSession(threadId)
  if (record === null || record === 'unavailable') return
  const slot = slotOf(useThreadStore.getState().slots, threadId)
  if (slot === undefined || record.revision <= slot.revision) return
  applyRecord(threadId, record)
  if (isLiveServerRun(record)) void followServerRun(threadId)
}

/** How long a stopped run is waited for: the server polls the cancel marker every 1.5 s. */
const STOP_SETTLE_BOUND_MS = 30_000

/**
 * After Stop: the server is cancelling the run and saves the partial answer as `stopped` itself,
 * so a save from this tab would be refused (409) while the run is live (5.35.03, e2e 5.35.02).
 * Poll until the stored run is no longer live, then take the server's copy — only into a thread
 * that is still idle (a new message or a closed thread is left alone). Resolves false when the
 * server holds nothing newer than this tab has (the run never reached it, or the wait timed out):
 * then this tab's own copy is the one to save.
 */
export async function adoptAfterStop(threadId: string, started: number = Date.now(), attempt = 0): Promise<boolean> {
  if (Date.now() - started >= STOP_SETTLE_BOUND_MS) return false
  await sleep(delayFor(attempt))
  if (statusOf(threadId) !== 'idle') return true
  const record = await readSession(threadId)
  if (record === null) return false
  if (record === 'unavailable' || isLiveServerRun(record)) return adoptAfterStop(threadId, started, attempt + 1)
  const slot = slotOf(useThreadStore.getState().slots, threadId)
  if (slot === undefined || record.revision <= slot.revision) return false
  applyRecord(threadId, record)
  return true
}
