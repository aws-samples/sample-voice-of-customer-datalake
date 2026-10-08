/**
 * @fileoverview Pure thread reducer: AG-UI events (and a few local actions) →
 * {@link ThreadState}.
 *
 * Rules worth knowing:
 * - The assistant message is created on first sight of EITHER its
 *   TEXT_MESSAGE_START or a TOOL_CALL_START naming it as `parentMessageId` — a
 *   Bedrock turn that only calls tools has no text message.
 * - TOOL_CALL_ARGS deltas concatenate into `function.arguments`; the JSON is
 *   parsed once, at TOOL_CALL_END.
 * - TOOL_CALL_RESULT appends a `tool` message, so the array stays in the order
 *   the model needs on the next run (assistant(toolUse) → tool → assistant).
 * - RUN_FINISHED with an interrupt outcome parks the tool-approval interrupts in
 *   `pendingInterrupts`; status becomes `awaiting_approval`.
 * - REASONING_ENCRYPTED_VALUE (subtype `message`) stores the server's opaque
 *   thinking blob on that assistant message's `encryptedValue`, which the wire
 *   copy and saved sessions keep and the UI never renders.
 * - Unknown/irrelevant events return the same state object.
 *
 * @module assistant/thread/reducer
 */
import { EventType } from '@ag-ui/core'
import { parseApprovalInterrupts, parseNavigation, parseRunContext, parseSources } from './customEvents'
import { CUSTOM_EVENTS } from '../contract'
import type { AssistantMessage, Message, ToolCall } from '@ag-ui/core'
import type { AguiEvent } from '../agui/sse'
import type { ApprovalInterrupt, ApprovalResolution } from '../types'
import type { ThreadError, ThreadState, ToolCallStatus } from './types'

export type ThreadAction =
  | { type: 'event'; event: AguiEvent }
  | { type: 'local/user_message'; message: Message }
  | { type: 'local/run_requested'; runId: string }
  | { type: 'local/aborted' }
  | { type: 'local/failed'; error: ThreadError }
  | { type: 'local/stream_closed' }
  | { type: 'local/resolution'; resolution: ApprovalResolution }
  | { type: 'local/apply_resolutions'; toolMessages: Message[] }
  | { type: 'local/restore'; state: ThreadState }

export function createThreadState(threadId: string): ThreadState {
  return {
    threadId,
    runId: null,
    messages: [],
    reasoningByMessage: {},
    reasoningBuffer: '',
    toolCallStatus: {},
    toolCallArgs: {},
    toolResults: {},
    pendingInterrupts: [],
    resolutions: {},
    sources: {},
    navigation: {},
    usage: [],
    context: null,
    status: 'idle',
    error: null,
    lastAssistantId: null,
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

/** Ensure an assistant message `id` exists; attaches buffered reasoning on creation. */
function ensureAssistant(state: ThreadState, id: string): ThreadState {
  if (state.messages.some((m) => m.id === id)) return { ...state, lastAssistantId: id }
  const created: AssistantMessage = { id, role: 'assistant', content: '' }
  const reasoning = state.reasoningBuffer
  return {
    ...state,
    messages: [...state.messages, created],
    lastAssistantId: id,
    reasoningBuffer: '',
    reasoningByMessage: reasoning === '' ? state.reasoningByMessage : { ...state.reasoningByMessage, [id]: reasoning },
  }
}

function updateAssistant(state: ThreadState, id: string, update: (m: AssistantMessage) => AssistantMessage): ThreadState {
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === id && isAssistant(m) ? update(m) : m)),
  }
}

function updateToolCall(state: ThreadState, toolCallId: string, update: (call: ToolCall) => ToolCall): ThreadState {
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (!isAssistant(m) || !m.toolCalls?.some((c) => c.id === toolCallId)) return m
      return { ...m, toolCalls: m.toolCalls.map((c) => (c.id === toolCallId ? update(c) : c)) }
    }),
  }
}

function setToolStatus(state: ThreadState, toolCallId: string, status: ToolCallStatus): ThreadState {
  return { ...state, toolCallStatus: { ...state.toolCallStatus, [toolCallId]: status } }
}

export function findToolCall(messages: readonly Message[], toolCallId: string): ToolCall | undefined {
  for (const message of messages) {
    if (!isAssistant(message)) continue
    const found = message.toolCalls?.find((c) => c.id === toolCallId)
    if (found) return found
  }
  return undefined
}

export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  } catch {
    return undefined
  }
}

/** Text of a tool result / tool message content (string or content parts). */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

// ── event groups (split to keep each switch small) ────────────────────────────

type EventOf<T extends AguiEvent['type']> = Extract<AguiEvent, { type: T }>

function reduceText(state: ThreadState, event: AguiEvent): ThreadState | null {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
      return ensureAssistant(state, event.messageId)
    case EventType.TEXT_MESSAGE_CONTENT: {
      const withMessage = ensureAssistant(state, event.messageId)
      return updateAssistant(withMessage, event.messageId, (m) => ({ ...m, content: `${m.content ?? ''}${event.delta}` }))
    }
    case EventType.TEXT_MESSAGE_END:
      return state
    default:
      return null
  }
}

function startToolCall(state: ThreadState, event: EventOf<EventType.TOOL_CALL_START>): ThreadState {
  const parentId = event.parentMessageId ?? state.lastAssistantId ?? `assistant-${event.toolCallId}`
  const withParent = ensureAssistant(state, parentId)
  const call: ToolCall = { id: event.toolCallId, type: 'function', function: { name: event.toolCallName, arguments: '' } }
  const updated = updateAssistant(withParent, parentId, (m) => ({ ...m, toolCalls: [...(m.toolCalls ?? []), call] }))
  return setToolStatus(updated, event.toolCallId, 'streaming')
}

function endToolCall(state: ThreadState, toolCallId: string): ThreadState {
  const call = findToolCall(state.messages, toolCallId)
  const args = call ? parseToolArguments(call.function.arguments) : undefined
  return setToolStatus({ ...state, toolCallArgs: { ...state.toolCallArgs, [toolCallId]: args } }, toolCallId, 'running')
}

function toolResult(state: ThreadState, event: EventOf<EventType.TOOL_CALL_RESULT>): ThreadState {
  const content = contentToText(event.content)
  const message: Message = { id: event.messageId, role: 'tool', toolCallId: event.toolCallId, content }
  return setToolStatus({
    ...state,
    messages: [...state.messages, message],
    toolResults: { ...state.toolResults, [event.toolCallId]: content },
  }, event.toolCallId, 'complete')
}

function reduceTool(state: ThreadState, event: AguiEvent): ThreadState | null {
  switch (event.type) {
    case EventType.TOOL_CALL_START:
      return startToolCall(state, event)
    case EventType.TOOL_CALL_ARGS:
      return updateToolCall(state, event.toolCallId, (c) => ({ ...c, function: { ...c.function, arguments: c.function.arguments + event.delta } }))
    case EventType.TOOL_CALL_END:
      return endToolCall(state, event.toolCallId)
    case EventType.TOOL_CALL_RESULT:
      return toolResult(state, event)
    default:
      return null
  }
}

/**
 * The server's opaque signed-thinking blob for one assistant turn. Stored
 * unchanged on that message's `encryptedValue` (never rendered) so the resume
 * run can hand Claude its thinking block back. The event may precede the turn's
 * first TOOL_CALL_START, so it can create the message like that event would.
 * Only `subtype: 'message'` is ours; anything else is ignored.
 */
function storeEncryptedReasoning(state: ThreadState, event: EventOf<EventType.REASONING_ENCRYPTED_VALUE>): ThreadState {
  if (event.subtype !== 'message') return state
  const withMessage = ensureAssistant(state, event.entityId)
  return updateAssistant(withMessage, event.entityId, (m) => ({ ...m, encryptedValue: event.encryptedValue }))
}

function reduceReasoning(state: ThreadState, event: AguiEvent): ThreadState | null {
  switch (event.type) {
    case EventType.REASONING_MESSAGE_CONTENT:
      return { ...state, reasoningBuffer: state.reasoningBuffer + event.delta }
    case EventType.REASONING_ENCRYPTED_VALUE:
      return storeEncryptedReasoning(state, event)
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_END:
      return state
    default:
      return null
  }
}

function reduceCustom(state: ThreadState, event: EventOf<EventType.CUSTOM>): ThreadState {
  const anchor = state.lastAssistantId
  if (event.name === CUSTOM_EVENTS.context) return { ...state, context: parseRunContext(event.value) }
  if (anchor === null) return state
  if (event.name === CUSTOM_EVENTS.sources) return { ...state, sources: { ...state.sources, [anchor]: parseSources(event.value) } }
  if (event.name === CUSTOM_EVENTS.navigation) {
    const nav = parseNavigation(event.value)
    if (nav === null) return state
    return { ...state, navigation: { ...state.navigation, [anchor]: [...(state.navigation[anchor] ?? []), nav] } }
  }
  return state
}

/** Reasoning that never got an assistant message is attached to the last one. */
function flushReasoning(state: ThreadState): ThreadState {
  if (state.reasoningBuffer === '' || state.lastAssistantId === null) return { ...state, reasoningBuffer: '' }
  const id = state.lastAssistantId
  return {
    ...state,
    reasoningBuffer: '',
    reasoningByMessage: { ...state.reasoningByMessage, [id]: (state.reasoningByMessage[id] ?? '') + state.reasoningBuffer },
  }
}

/** Tool calls still in flight when a run stops can never complete. */
function cancelInFlight(state: ThreadState): ThreadState {
  const toolCallStatus = Object.fromEntries(
    Object.entries(state.toolCallStatus).map(([id, s]) => [id, s === 'streaming' || s === 'running' ? 'cancelled' : s]),
  )
  return { ...flushReasoning(state), toolCallStatus }
}

function markInterrupts(state: ThreadState, interrupts: ApprovalInterrupt[]): ThreadState {
  return interrupts.reduce((acc, i) => setToolStatus(acc, i.toolCallId, 'awaiting_approval'), {
    ...state,
    pendingInterrupts: interrupts,
    resolutions: {},
  })
}

function runFinished(state: ThreadState, event: EventOf<EventType.RUN_FINISHED>): ThreadState {
  const flushed = { ...flushReasoning(state), usage: event.usage ?? state.usage }
  const outcome = event.outcome
  if (outcome?.type === 'interrupt') {
    const interrupts = parseApprovalInterrupts(outcome.interrupts)
    if (interrupts.length > 0) return { ...markInterrupts(flushed, interrupts), status: 'awaiting_approval' }
  }
  return { ...flushed, status: 'idle' }
}

function reduceRun(state: ThreadState, event: AguiEvent): ThreadState | null {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return { ...state, runId: event.runId, status: 'streaming', error: null, pendingInterrupts: [], resolutions: {} }
    case EventType.RUN_FINISHED:
      return runFinished(state, event)
    case EventType.RUN_ERROR:
      // Like a local failure: tool calls still streaming/running can never complete now.
      return { ...cancelInFlight(state), status: 'error', error: { message: event.message, ...(event.code !== undefined ? { code: event.code } : {}) } }
    case EventType.CUSTOM:
      return reduceCustom(state, event)
    default:
      return null
  }
}

function reduceEvent(state: ThreadState, event: AguiEvent): ThreadState {
  return reduceText(state, event)
    ?? reduceTool(state, event)
    ?? reduceReasoning(state, event)
    ?? reduceRun(state, event)
    ?? state
}

// ── local actions ────────────────────────────────────────────────────────────

function applyResolutions(state: ThreadState, toolMessages: Message[]): ThreadState {
  const withStatuses = Object.values(state.resolutions).reduce(
    (acc, r) => setToolStatus(acc, r.toolCallId, r.outcome.status),
    state,
  )
  const toolResults = { ...withStatuses.toolResults }
  for (const m of toolMessages) {
    if (m.role === 'tool') toolResults[m.toolCallId] = contentToText(m.content)
  }
  return {
    ...withStatuses,
    messages: [...withStatuses.messages, ...toolMessages],
    toolResults,
    pendingInterrupts: [],
    resolutions: {},
  }
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'event':
      return reduceEvent(state, action.event)
    case 'local/user_message':
      return { ...state, messages: [...state.messages, action.message], error: null, lastAssistantId: null }
    case 'local/run_requested':
      return { ...state, runId: action.runId, status: 'streaming', error: null, lastAssistantId: null }
    case 'local/aborted':
      return { ...cancelInFlight(state), status: 'idle' }
    case 'local/failed':
      return { ...cancelInFlight(state), status: 'error', error: action.error }
    case 'local/stream_closed':
      return state.status === 'streaming'
        ? { ...cancelInFlight(state), status: 'error', error: { message: 'stream_closed', code: 'STREAM_CLOSED' } }
        : state
    case 'local/resolution':
      return { ...state, resolutions: { ...state.resolutions, [action.resolution.interruptId]: action.resolution } }
    case 'local/apply_resolutions':
      return applyResolutions(state, action.toolMessages)
    case 'local/restore':
      return action.state
    default:
      return state
  }
}

/** True when every pending interrupt has a recorded resolution. */
export function allInterruptsResolved(state: ThreadState): boolean {
  return state.pendingInterrupts.length > 0
    && state.pendingInterrupts.every((i) => Object.hasOwn(state.resolutions, i.id))
}
