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
import { chatScopeFor } from '../store/chatScopeStore'
import { allInterruptsResolved } from '../thread/reducer'
import { buildResume } from '../thread/resume'
import { toWireMessages } from '../thread/wire'
import { cancelServerRun, getSession, saveSession } from '../sessions/sessionsApi'
import { threadFromSession, toSaveBody } from '../sessions/serialize'
import { isValidSessionId } from '../sessions/schema'
import { onAssistantSignOut, slotOf, useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { announceRunEnd } from '../notifications/runNotifications'
import { isChatRoute } from '../page/chatRoute'
import { apiErrorStatus, HTTP_CONFLICT } from '../../api/apiErrorStatus'
import { CUSTOM_EVENTS } from '../contract'
import { adoptAfterStop, adoptServerSession, followServerRun } from './followServerRun'
import { mentionsOfLastTurn } from '../mentions/mentionsOfTurn'
import type { AguiEvent } from '../agui/sse'
import type { ContentPart, Message, ResumeEntry } from '@ag-ui/core'
import { EventType } from '@ag-ui/core'
import type { Mentions, PageContext } from '../contract'
import type { ApprovalResolution } from '../types'
import type { ThreadAction } from '../thread/reducer'
import type { ThreadState } from '../thread/types'
import type { SessionRecord } from '../sessions/schema'
import { ignoreRejection } from '../../lib/rejections'

export interface RunEnvironment {
  page: PageContext
  language?: string
  useWebSearch: boolean
}

/** The live run of each thread, by thread id. */
const inFlight = new Map<string, AbortController>()
/** The run id of each thread's live run (what Stop asks the server to cancel). */
const inFlightRunIds = new Map<string, string>()

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

/**
 * Persist one thread; failures are non-fatal (the thread stays in memory).
 *
 * The server owns a run's answer (the stream Lambda saves it while it
 * streams), so the save carries the newest server revision this tab has seen
 * and the server refuses it (409) when it holds a newer one or a run is still
 * live. Then this tab adopts the server's copy instead — which is how a stream
 * cut mid-answer still ends with the complete answer.
 */
async function saveThreadNow(threadId: string, page: PageContext | null, adoptOnConflict: boolean, refreshList: boolean): Promise<void> {
  const slot = slotOf(useThreadStore.getState().slots, threadId)
  if (slot === undefined) return
  const { thread: state, createdAt, revision } = slot
  if (state.messages.length === 0 || !isValidSessionId(state.threadId)) return
  try {
    await saveSession(toSaveBody(state, page, createdAt, revision))
    if (threadId === activeId()) rememberInView()
    if (refreshList) useThreadStore.getState().noteSaved()
  } catch (error) {
    if (adoptOnConflict && apiErrorStatus(error) === HTTP_CONFLICT) void adoptServerSession(threadId)
    // Otherwise saving is best-effort; the next finished run retries with the full thread.
  }
}

/**
 * The server's final-save revision for this run (`assistant.session`, just before the run ends).
 * True when the event was one: the server has stored the run's outcome.
 */
function noteServerRevision(threadId: string, event: AguiEvent): boolean {
  if (event.type !== EventType.CUSTOM || event.name !== CUSTOM_EVENTS.session) return false
  const value: unknown = event.value
  const revision: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'revision') : undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) return false
  useThreadStore.getState().setRevision(threadId, revision)
  return true
}

/**
 * After a run: the stream Lambda stores exactly what this tab would (session/record.ts mirrors
 * sessions/serialize.ts) and said so with `assistant.session`. When the run also ended cleanly here
 * (an answer, or a stop for approval), saving the same conversation again is a second POST and a
 * second list refetch per turn (wave 4) — the server's copy stands. A failed or cut run still saves.
 */
function serverHoldsOutcome(threadId: string, serverSaved: boolean): boolean {
  const status = threadOf(threadId)?.status
  return serverSaved && (status === 'idle' || status === 'awaiting_approval')
}

function noteServerSaved(threadId: string): void {
  if (threadId === activeId()) rememberInView()
  useThreadStore.getState().noteSaved()
}

/** The tail of each thread's save chain, so its saves reach the server in order. */
const saveChains = new Map<string, Promise<void>>()

/**
 * Persist one thread AFTER any save of it already in flight. A thread is saved
 * as a run starts and again when it ends; chaining keeps a slow first save from
 * landing after (and overwriting) the final one. Each save reads the thread at
 * the moment it runs, so the last one always carries the latest state.
 * `refreshList` false (the save made as a run starts): the conversation list
 * refetches once per turn, after the run, not twice.
 */
function persistThread(threadId: string, page: PageContext | null, adoptOnConflict = true, refreshList = true): Promise<void> {
  const next = (saveChains.get(threadId) ?? Promise.resolve()).then(() => saveThreadNow(threadId, page, adoptOnConflict, refreshList))
  saveChains.set(threadId, next)
  void next.then(() => {
    if (saveChains.get(threadId) === next) saveChains.delete(threadId)
  })
  return next
}

interface RunOptions {
  resume?: ResumeEntry[]
  beforeStream?: () => Promise<void>
  /** The personas / documents the user mentioned in the message this run answers. */
  mentions?: Mentions
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
async function executeRun(threadId: string, env: RunEnvironment, { resume, beforeStream, mentions }: RunOptions): Promise<void> {
  inFlight.get(threadId)?.abort()
  const controller = new AbortController()
  inFlight.set(threadId, controller)
  const runId = newId()
  const started = dispatchTo(threadId, { type: 'local/run_requested' })
  const input = buildRunInput({
    threadId,
    runId,
    // Stryker disable next-line ArrayDeclaration: toWireMessages keeps only user/assistant/tool messages, so a non-message placeholder is dropped and the wire list is [] either way
    messages: toWireMessages(started?.messages ?? []),
    forwardedProps: buildForwardedProps({
      page: env.page, language: env.language, useWebSearch: env.useWebSearch, mentions, scope: chatScopeFor(threadId),
    }),
    resume,
  })
  const seen = { serverSaved: false }
  try {
    if (beforeStream !== undefined) await beforeStream()
    // Stopped while the question was being saved: stopRun already settled the thread.
    // (Read through a call: a direct `signal.aborted` check would narrow it to false for the rest of the function.)
    if (isAborted(controller)) return
    // Registered only now: from here on the server may own the run, so Stop must cancel it there.
    inFlightRunIds.set(threadId, runId)
    await runAgent(input, (event) => {
      if (controller.signal.aborted) return
      if (noteServerRevision(threadId, event)) seen.serverSaved = true
      dispatchTo(threadId, { type: 'event', event })
    }, controller.signal)
    if (!controller.signal.aborted) dispatchTo(threadId, { type: 'local/stream_closed' })
  } catch (error) {
    if (controller.signal.aborted) return
    dispatchTo(threadId, { type: 'local/failed', error: { message: errorMessage(error) } })
  } finally {
    if (inFlight.get(threadId) === controller) {
      inFlight.delete(threadId)
      inFlightRunIds.delete(threadId)
    }
  }
  if (!controller.signal.aborted) {
    announceEnd(threadId)
    if (serverHoldsOutcome(threadId, seen.serverSaved)) noteServerSaved(threadId)
    else await persistThread(threadId, env.page)
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
export async function sendMessage(
  content: string | ContentPart[], env: RunEnvironment, threadId: string = activeId(), mentions?: Mentions,
): Promise<void> {
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
  await executeRun(threadId, env, { beforeStream: () => persistThread(threadId, env.page, false, false), mentions })
}

/**
 * Abort a thread's run; partial text stays (marked Stopped), unfinished tool calls are cancelled.
 *
 * The browser's abort does not reach the stream Lambda, which would run on without a client
 * (Bedrock still spent, and a reload showed the full answer — E2E 5.34). So Stop also asks the
 * server to cancel the run: it stops within a couple of seconds and saves the partial answer as
 * `stopped`. Until it has, a save from this tab would be refused (409), so none is sent: the tab
 * waits for the server's copy (adoptAfterStop) and saves its own only when the server has none.
 * Stopped before the stream was requested (the question still saving): no server run, a plain save.
 */
export function stopRun(page: PageContext | null = null, threadId: string = activeId()): void {
  const controller = inFlight.get(threadId)
  if (controller === undefined) return
  const runId = inFlightRunIds.get(threadId)
  controller.abort()
  inFlight.delete(threadId)
  inFlightRunIds.delete(threadId)
  dispatchTo(threadId, { type: 'local/aborted' })
  if (runId !== undefined && isValidSessionId(threadId)) {
    // Best effort: a failed cancel leaves the run to finish on its own, as before.
    cancelServerRun(threadId, runId).catch(ignoreRejection)
    void settleStoppedRun(threadId, page)
    return
  }
  void persistThread(threadId, page, false)
}

async function settleStoppedRun(threadId: string, page: PageContext | null): Promise<void> {
  if (!(await adoptAfterStop(threadId))) await persistThread(threadId, page, false)
}

/**
 * Answer the last question again: the last answer is dropped and the question re-run. Only on an
 * idle or failed thread (not while it streams, waits for an approval or the server generates).
 */
export async function regenerate(env: RunEnvironment, threadId: string = activeId()): Promise<void> {
  const status = threadOf(threadId)?.status
  if (status !== 'idle' && status !== 'error') return
  // The same personas answer again: the round's own calls name them (an @all is already resolved there).
  const mentions = mentionsOfLastTurn(threadOf(threadId)?.messages ?? [])
  dispatchTo(threadId, { type: 'local/regenerate' })
  await executeRun(threadId, env, { beforeStream: () => persistThread(threadId, env.page, false, false), mentions })
}

/** Start the resume run once every pending approval has a resolution. */
function resumeIfReady(threadId: string, env: RunEnvironment): void {
  const state = threadOf(threadId)
  // Stryker disable next-line ConditionalExpression,OptionalChaining: both callers hand over an open thread that is awaiting approval (resolveApproval checked it; a loaded session is awaiting iff it has pending interrupts), so this line only narrows the type
  if (state?.status !== 'awaiting_approval') return
  if (!allInterruptsResolved(state)) return
  const { toolMessages, resume } = buildResume(state.pendingInterrupts, state.resolutions)
  dispatchTo(threadId, { type: 'local/apply_resolutions', toolMessages })
  void executeRun(threadId, env, { resume })
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
  showLoadedSession(record, env)
  return true
}

/**
 * Bring a session just read from storage into view. Still being answered
 * server-side (a reload mid-answer): show the partial answer and poll until it
 * finishes; otherwise pick up any approvals left to answer.
 */
export function showLoadedSession(record: SessionRecord, env: RunEnvironment): void {
  const thread = threadFromSession(record)
  useThreadStore.getState().replace(thread, record.createdAt === '' ? undefined : record.createdAt, record.revision)
  useAssistantUiStore.getState().setActiveThreadId(record.id)
  if (thread.status === 'generating') void followServerRun(record.id)
  else resumeIfReady(record.id, env)
}

onAssistantSignOut(() => {
  for (const controller of inFlight.values()) controller.abort()
  inFlight.clear()
  inFlightRunIds.clear()
})
