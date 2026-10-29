/**
 * @fileoverview Thread state ⇄ stored session.
 *
 * A stopped answer carries `metadata.voc.stopped` (the stream Lambda writes the same marker,
 * session/recorder.ts), so its Stopped marker survives a reload.
 *
 * Saving keeps a record small and free of user uploads: every `tool` message
 * content is trimmed to {@link MAX_STORED_TOOL_CHARS} (a persona-cards result keeps
 * valid JSON within its own cap, personaResult.ts) and attachment parts lose
 * their data (name and mimeType survive in `metadata`). Feedback/web sources and
 * navigation chips ride in the assistant message's `metadata.voc` so a restored
 * thread still shows them; the wire copy (`thread/wire.ts`) drops metadata.
 * An assistant message's `encryptedValue` (signed thinking) is kept verbatim so
 * a restored thread can still resume an approval; it counts toward the record
 * size like any other content (the 413 retry below trims turns, never it).
The saved list is windowed to `LIMITS.maxMessages` with the wire copy's
turn-preserving helper, so a long thread keeps saving its newest turns.
 *
 * Restoring rebuilds the per-tool-call bookkeeping from the messages, and
 * re-raises any pending approvals — expired ones come back already declined.
 *
 * @module assistant/sessions/serialize
 */
import { z } from 'zod'
import { createThreadState, contentToText, parseToolArguments } from '../thread/reducer'
import { parseNavigation, parseSources } from '../thread/customEvents'
import { expiredResolution, isExpired } from '../thread/resume'
import { attachmentName, keepNewestTurns } from '../thread/wire'
import { LIMITS, toolOutcomeSchema } from '../contract'
import { SESSION_KIND, isLiveServerRun } from './schema'
import { MAX_RETRY_PERSONA_CHARS, MAX_STORED_PERSONA_CHARS, storedPersonaResult } from './personaResult'
import type { ContentPart, Message } from '@ag-ui/core'
import type { PageContext } from '../contract'
import type { ThreadState, ToolCallStatus } from '../thread/types'
import type { SessionRecord } from './schema'

export const MAX_STORED_TOOL_CHARS = 4000
/** Tool content cap for the 413 retry of a thread that is a single turn. */
export const MAX_RETRY_TOOL_CHARS = 1000
/**
 * The stored auto-title: chat_handler.MAX_TITLE_CHARS, the longest name a rename may set, so the
 * rename field can open on the whole first message rather than a cut one (5.35, the field used to
 * open on a 60-character title ending in an ellipsis). The list clamps it to two lines on screen.
 */
export const MAX_TITLE_CHARS = 120

export interface SaveSessionBody {
  id: string
  kind: typeof SESSION_KIND
  title: string
  messages: Message[]
  page: PageContext | null
  pendingInterrupts: ThreadState['pendingInterrupts']
  createdAt: string
  /** The newest server revision this tab has seen; the server refuses (409) a save older than its own. */
  baseRevision: number
}

function stripPart(part: ContentPart): ContentPart {
  if (part.type === 'text') return part
  const mimeType = part.source.mimeType ?? 'application/octet-stream'
  return {
    type: part.type,
    source: { type: 'data', value: '', mimeType },
    metadata: { name: attachmentName(part), mimeType },
  }
}

/** A tool content within its cap; a persona-cards result stays valid JSON (personaResult.ts). */
function storedToolText(text: string, toolChars: number, personaChars: number): string {
  return storedPersonaResult(text, personaChars) ?? text.slice(0, toolChars)
}

function storedMessage(message: Message, state: ThreadState): Message {
  if (message.role === 'tool') {
    return { ...message, content: storedToolText(contentToText(message.content), MAX_STORED_TOOL_CHARS, MAX_STORED_PERSONA_CHARS) }
  }
  if (message.role === 'user' && typeof message.content !== 'string') {
    return { ...message, content: message.content.map(stripPart) }
  }
  if (message.role === 'assistant') {
    const hasSources = Object.hasOwn(state.sources, message.id)
    const hasNavigation = Object.hasOwn(state.navigation, message.id)
    const stopped = state.stopped[message.id] === true
    if (!hasSources && !hasNavigation && !stopped) return message
    const voc = {
      ...(hasSources ? { sources: state.sources[message.id] } : {}),
      ...(hasNavigation ? { navigation: state.navigation[message.id] } : {}),
      ...(stopped ? { stopped: true } : {}),
    }
    return { ...message, metadata: { ...message.metadata, voc } }
  }
  return message
}

const ELLIPSIS = '…'

function firstUserText(messages: readonly Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  return first ? contentToText(first.content).replace(/\s+/g, ' ').trim() : ''
}

/** First user message as plain text, ≤ MAX_TITLE_CHARS (a longer one is cut and ends in an ellipsis). */
export function sessionTitle(messages: readonly Message[]): string {
  const text = firstUserText(messages)
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}${ELLIPSIS}` : text
}

/**
 * What the rename field opens on: the user's own name when there is one, else the auto-title
 * without the ellipsis a cut adds (the field holds MAX_TITLE_CHARS, so that is the longest
 * name it could save anyway). An open conversation passes its messages: the whole first message.
 */
export function editableTitle(title: string, customTitle: string | null, messages?: readonly Message[]): string {
  if (customTitle !== null) return customTitle
  const full = messages === undefined ? '' : firstUserText(messages).slice(0, MAX_TITLE_CHARS)
  if (full !== '') return full
  return title.endsWith(ELLIPSIS) ? title.slice(0, -ELLIPSIS.length).trimEnd() : title
}

export function toSaveBody(state: ThreadState, page: PageContext | null, createdAt: string, baseRevision = 0): SaveSessionBody {
  return {
    id: state.threadId,
    kind: SESSION_KIND,
    title: sessionTitle(state.messages),
    // Same window as the wire copy: the server refuses more than LIMITS.maxMessages.
    messages: keepNewestTurns(state.messages, LIMITS.maxMessages).map((m) => storedMessage(m, state)),
    page,
    pendingInterrupts: state.pendingInterrupts,
    createdAt,
    baseRevision,
  }
}

function shrinkToolContents(messages: readonly Message[], maxChars: number): Message[] {
  return messages.map((m) => (m.role === 'tool'
    ? { ...m, content: storedToolText(contentToText(m.content), maxChars, MAX_RETRY_PERSONA_CHARS) }
    : m))
}

/**
 * Shrink a record once after a 413. With several turns, drop the oldest half
 * (a turn starts at a user message), so the list still opens on a user
 * message. With one turn there is nothing safe to drop — the user's request and
 * each assistant+tool pair must survive — so keep the turn from its user
 * message on and shrink tool contents to {@link MAX_RETRY_TOOL_CHARS} instead.
 */
export function dropOldestTurns(messages: readonly Message[]): Message[] {
  const turnStarts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  if (turnStarts.length > 1) return messages.slice(turnStarts[Math.floor(turnStarts.length / 2)])
  const from = turnStarts.length === 1 ? turnStarts[0] : 0
  return shrinkToolContents(messages.slice(from), MAX_RETRY_TOOL_CHARS)
}

// ── restore ────────────────────────────────────────────────────────────────

const vocMetadataSchema = z.object({
  voc: z.object({ sources: z.unknown().optional(), navigation: z.unknown().optional(), stopped: z.boolean().catch(false).optional() }),
})

function outcomeStatus(content: string): ToolCallStatus {
  try {
    const parsed = toolOutcomeSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data.status : 'complete'
  } catch {
    return 'complete'
  }
}

function restoreMetadata(state: ThreadState, message: Message): ThreadState {
  const meta = vocMetadataSchema.safeParse('metadata' in message ? message.metadata : undefined)
  if (!meta.success) return state
  const navigation = Array.isArray(meta.data.voc.navigation)
    ? meta.data.voc.navigation.flatMap((n: unknown) => {
      const parsed = parseNavigation(n)
      return parsed ? [parsed] : []
    })
    : []
  return {
    ...state,
    sources: meta.data.voc.sources === undefined ? state.sources : { ...state.sources, [message.id]: parseSources(meta.data.voc.sources) },
    navigation: navigation.length === 0 ? state.navigation : { ...state.navigation, [message.id]: navigation },
    stopped: meta.data.voc.stopped === true ? { ...state.stopped, [message.id]: true } : state.stopped,
  }
}

function restoreMessage(state: ThreadState, message: Message): ThreadState {
  if (message.role === 'tool') {
    const content = contentToText(message.content)
    return {
      ...state,
      toolResults: { ...state.toolResults, [message.toolCallId]: content },
      toolCallStatus: { ...state.toolCallStatus, [message.toolCallId]: outcomeStatus(content) },
    }
  }
  if (message.role !== 'assistant') return state
  const withCalls = (message.toolCalls ?? []).reduce<ThreadState>((acc, call) => ({
    ...acc,
    toolCallArgs: { ...acc.toolCallArgs, [call.id]: parseToolArguments(call.function.arguments) },
    toolCallStatus: { ...acc.toolCallStatus, [call.id]: 'cancelled' },
  }), state)
  return restoreMetadata(withCalls, message)
}

/**
 * Rebuild a thread from a stored session. A session the server is still
 * generating comes back `generating` (the partial answer shows; the runtime
 * polls until it finishes); its pending approvals, if any, are not raised yet.
 */
export function threadFromSession(record: SessionRecord, now: number = Date.now()): ThreadState {
  const base = { ...createThreadState(record.id), messages: record.messages }
  const restored = record.messages.reduce(restoreMessage, base)
  if (isLiveServerRun(record, now)) return { ...restored, status: 'generating' }
  const answered = new Set(Object.keys(restored.toolResults))
  const pending = record.pendingInterrupts.filter((i) => !answered.has(i.toolCallId))
  if (pending.length === 0) return restored
  const resolutions = Object.fromEntries(
    pending.filter((i) => isExpired(i, now)).map((i) => [i.id, expiredResolution(i)]),
  )
  const toolCallStatus = { ...restored.toolCallStatus }
  for (const i of pending) toolCallStatus[i.toolCallId] = 'awaiting_approval'
  return { ...restored, pendingInterrupts: pending, resolutions, toolCallStatus, status: 'awaiting_approval' }
}
