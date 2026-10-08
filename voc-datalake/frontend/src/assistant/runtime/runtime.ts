/**
 * @fileoverview The assistant runtime: drives runs against `/chat/stream`,
 * handles stop, approvals → resume, and session persistence.
 *
 * Plain functions over the module stores (not a hook) so the floating panel and
 * the `/chat` page share the same conversations, and so the flow is testable
 * without rendering.
 *
 * Several conversations can run at once — one run per thread at most. Every
 * function acts on an explicit thread id (defaulting to the one in view), and
 * a run keeps writing to the thread it started on even after the user switches
 * to another one. Each thread's AbortController lives in `inFlight`.
 *
 * @module assistant/runtime/runtime
 */
import { buildRunInput, newId, runAgent } from '../agui/client'
import { buildForwardedProps } from '../agui/forwardedProps'
import { allInterruptsResolved } from '../thread/reducer'
import { buildResume } from '../thread/resume'
import { toWireMessages } from '../thread/wire'
import { getSession, saveSession } from '../sessions/sessionsApi'
import { threadFromSession, toSaveBody } from '../sessions/serialize'
import { isValidSessionId } from '../sessions/schema'
import { onAssistantSignOut, slotOf, useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { announceRunEnd } from '../notifications/runNotifications'
import { isChatRoute } from '../page/chatRoute'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { CUSTOM_EVENTS } from '../contract'
import { adoptServerSession, followServerRun } from './followServerRun'
import type { AguiEvent } from '../agui/sse'
import type { ContentPart, Message, ResumeEntry } from '@ag-ui/core'
import type { PageContext } from '../contract'
import type { ApprovalResolution } from '../types'
import type { ThreadAction } from '../thread/reducer'
import type { ThreadState } from '../thread/types'

export interface RunEnvironment {
  page: PageContext
  language?: string
  useWebSearch: boolean
}

/** The live run of each thread, by thread id. */
const inFlight = new Map<string, AbortController>()

function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted
}

function activeId(): string {
  return useThreadStore.getState().activeId
}

function threadOf(threadId: string): ThreadState | undefined {
  return slotOf(useThreadStore.getState().slots, threadId)?.thread
}

function dispatchTo(threadId: string, action: ThreadAction) {
  return useThreadStore.getState().dispatchTo(threadId, action)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/**
 * Remember the conversation in view so a reload brings it back; an empty one
 * has no stored session, so nothing is remembered for it.
 */
function rememberInView(): void {
  const { thread } = useThreadStore.getState()
  useAssistantUiStore.getState().setActiveThreadId(thread.messages.length > 0 ? thread.threadId : null)
}

const CONFLICT = 409

/**
 * Persist one thread; failures are non-fatal (the thread stays in memory).
 *
 * The server owns a run's answer (the stream Lambda saves it while it
 * streams), so the save carries the newest server revision this tab has seen
 * and the server refuses it (409) when it holds a newer one or a run is still
 * live. Then this tab adopts the server's copy instead — which is how a stream
 * cut mid-answer still ends with the complete answer.
 */
async function saveThreadNow(threadId: string, page: PageContext | null, adoptOnConflict: boolean): Promise<void> {
  const slot = slotOf(useThreadStore.getState().slots, threadId)
  if (slot === undefined) return
  const { thread: state, createdAt, revision } = slot
  if (state.messages.length === 0 || !isValidSessionId(state.threadId)) return
  try {
    await saveSession(toSaveBody(state, page, createdAt, revision))
    if (threadId === activeId()) rememberInView()
    useThreadStore.getState().noteSaved()
  } catch (error) {
    if (adoptOnConflict && apiErrorStatus(error) === CONFLICT) void adoptServerSession(threadId)
    // Otherwise saving is best-effort; the next finished run retries with the full thread.
  }
}

/** The server's final-save revision for this run (`assistant.session`, just before the run ends). */
function noteServerRevision(threadId: string, event: AguiEvent): void {
  if (event.type !== 'CUSTOM' || event.name !== CUSTOM_EVENTS.session) return
  const value: unknown = event.value
  const revision: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'revision') : undefined
  if (typeof revision === 'number' && Number.isSafeInteger(revision)) useThreadStore.getState().setRevision(threadId, revision)
}

/** The tail of each thread's save chain, so its saves reach the server in order. */
const saveChains = new Map<string, Promise<void>>()

/**
 * Persist one thread AFTER any save of it already in flight. A thread is saved
 * as a run starts and again when it ends; chaining keeps a slow first save from
 * landing after (and overwriting) the final one. Each save reads the thread at
 * the moment it runs, so the last one always carries the latest state.
 */
function persistThread(threadId: string, page: PageContext | null, adoptOnConflict = true): Promise<void> {
  const next = (saveChains.get(threadId) ?? Promise.resolve()).then(() => saveThreadNow(threadId, page, adoptOnConflict))
  saveChains.set(threadId, next)
  void next.then(() => {
    if (saveChains.get(threadId) === next) saveChains.delete(threadId)
  })
  return next
}

/**
 * Run a thread that is open — both callers (sendMessage, resumeIfReady) have just checked it.
 *
 * `beforeStream` runs once the thread is already `streaming` (so a second Send
 * is ignored and Stop works) but BEFORE `/chat/stream` is requested. The send
 * path saves the question there: the stream Lambda writes the same item as soon
 * as it starts, so a save still in flight when it does is refused (409, logged
 * by the browser as a failed request) — awaiting it first leaves the server the
 * only writer for the rest of the run.
 */
async function executeRun(threadId: string, env: RunEnvironment, resume?: ResumeEntry[], beforeStream?: () => Promise<void>): Promise<void> {
  inFlight.get(threadId)?.abort()
  const controller = new AbortController()
  inFlight.set(threadId, controller)
  const runId = newId()
  const started = dispatchTo(threadId, { type: 'local/run_requested', runId })
  const input = buildRunInput({
    threadId,
    runId,
    // Stryker disable next-line ArrayDeclaration: toWireMessages keeps only user/assistant/tool messages, so a non-message placeholder is dropped and the wire list is [] either way
    messages: toWireMessages(started?.messages ?? []),
    forwardedProps: buildForwardedProps({ page: env.page, language: env.language, useWebSearch: env.useWebSearch }),
    resume,
  })
  try {
    if (beforeStream !== undefined) await beforeStream()
    // Stopped while the question was being saved: stopRun already settled the thread.
    // (Read through a call: a direct `signal.aborted` check would narrow it to false for the rest of the function.)
    if (isAborted(controller)) return
    await runAgent(input, (event) => {
      if (controller.signal.aborted) return
      noteServerRevision(threadId, event)
      dispatchTo(threadId, { type: 'event', event })
    }, controller.signal)
    if (!controller.signal.aborted) dispatchTo(threadId, { type: 'local/stream_closed' })
  } catch (error) {
    if (controller.signal.aborted) return
    dispatchTo(threadId, { type: 'local/failed', error: { message: errorMessage(error) } })
  } finally {
    if (inFlight.get(threadId) === controller) inFlight.delete(threadId)
  }
  if (!controller.signal.aborted) {
    announceEnd(threadId)
    await persistThread(threadId, env.page)
  }
}

/** Whether the user is looking at this thread: it is in view, in an open panel or on `/chat`. */
function threadOnScreen(threadId: string): boolean {
  if (threadId !== activeId()) return false
  return useAssistantUiStore.getState().open || isChatRoute(window.location.pathname)
}

/** Desktop notification for a run that ended out of sight (opt-in; see runNotifications). */
function announceEnd(threadId: string): void {
  const thread = threadOf(threadId)
  if (thread === undefined) return
  announceRunEnd(threadId, thread, {
    enabled: useAssistantUiStore.getState().notify,
    threadOnScreen: threadOnScreen(threadId),
    onOpen: () => {
      switchThread(threadId)
      if (!isChatRoute(window.location.pathname)) useAssistantUiStore.getState().setOpen(true)
    },
  })
}

/**
 * Send a user message and run. Ignored while THAT thread streams or has open
 * approvals — other threads may be running at the same time.
 */
export async function sendMessage(content: string | ContentPart[], env: RunEnvironment, threadId: string = activeId()): Promise<void> {
  const status = threadOf(threadId)?.status
  // `generating`: the server is still answering the previous message (followServerRun).
  if (status === undefined || status === 'streaming' || status === 'awaiting_approval' || status === 'generating') return
  const message: Message = { id: newId(), role: 'user', content }
  dispatchTo(threadId, { type: 'local/user_message', message })
  // Saved BEFORE the run, not only after it: a reload or a dropped tab
  // mid-run used to lose the question (and a brand-new conversation entirely,
  // since nothing was stored for it yet). The save completes before the stream
  // starts — it used to race the stream Lambda's first write and lose with a
  // 409 on about half of first messages. No adopting on a refusal here: the
  // run about to start owns the answer, and adopting could drop the question.
  await executeRun(threadId, env, undefined, () => persistThread(threadId, env.page, false))
}

/** Abort a thread's run; partial text stays, unfinished tool calls are cancelled. */
export function stopRun(page: PageContext | null = null, threadId: string = activeId()): void {
  const controller = inFlight.get(threadId)
  if (controller === undefined) return
  controller.abort()
  inFlight.delete(threadId)
  dispatchTo(threadId, { type: 'local/aborted' })
  // The user stopped: keep what they saw. The server may still finish the
  // answer (it runs on without a client); reopening the session shows it.
  void persistThread(threadId, page, false)
}

/** Start the resume run once every pending approval has a resolution. */
function resumeIfReady(threadId: string, env: RunEnvironment): void {
  const state = threadOf(threadId)
  // Stryker disable next-line ConditionalExpression,OptionalChaining: both callers hand over an open thread that is awaiting approval (resolveApproval checked it; a loaded session is awaiting iff it has pending interrupts), so this line only narrows the type
  if (state?.status !== 'awaiting_approval') return
  if (!allInterruptsResolved(state)) return
  const { toolMessages, resume } = buildResume(state.pendingInterrupts, state.resolutions)
  dispatchTo(threadId, { type: 'local/apply_resolutions', toolMessages })
  void executeRun(threadId, env, resume)
}

/**
 * Record one card's resolution on the thread it belongs to; the last one
 * triggers exactly one resume run. The thread id is explicit because a write
 * can finish after the user has switched to another conversation.
 */
export function resolveApproval(resolution: ApprovalResolution, env: RunEnvironment, threadId: string = activeId()): void {
  const state = threadOf(threadId)
  if (state?.status !== 'awaiting_approval') return
  if (!state.pendingInterrupts.some((i) => i.id === resolution.interruptId)) return
  if (Object.hasOwn(state.resolutions, resolution.interruptId)) return
  dispatchTo(threadId, { type: 'local/resolution', resolution })
  resumeIfReady(threadId, env)
}

/** Start a fresh conversation in view; running conversations keep running. */
export function newThread(): void {
  useThreadStore.getState().openNew()
  rememberInView()
}

/** Bring an open conversation into view. */
function switchThread(threadId: string): void {
  if (useThreadStore.getState().activate(threadId)) rememberInView()
}

/** Stop a conversation's run (if any) and drop it from memory; the saved session stays. */
export function closeThread(threadId: string, page: PageContext | null = null): void {
  stopRun(page, threadId)
  useThreadStore.getState().close(threadId)
  rememberInView()
}

/**
 * Bring a session into view. An open one is just switched to (it may be
 * running); otherwise it is loaded from storage. Pending approvals come back as
 * cards; expired ones are auto-declined, and if nothing is left to answer the
 * resume run starts so the model can report that the approval lapsed.
 */
export async function openSession(id: string, env: RunEnvironment): Promise<boolean> {
  if (threadOf(id) !== undefined) {
    switchThread(id)
    return true
  }
  const record = await getSession(id)
  if (record === null) return false
  const thread = threadFromSession(record)
  useThreadStore.getState().replace(thread, record.createdAt === '' ? undefined : record.createdAt, record.revision)
  useAssistantUiStore.getState().setActiveThreadId(record.id)
  // Still being answered server-side (a reload mid-answer): show the partial
  // answer and poll until it finishes.
  if (thread.status === 'generating') void followServerRun(record.id)
  else resumeIfReady(record.id, env)
  return true
}

onAssistantSignOut(() => {
  for (const controller of inFlight.values()) controller.abort()
  inFlight.clear()
})
