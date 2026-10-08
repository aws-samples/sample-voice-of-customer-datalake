/**
 * @fileoverview The `messages` actually sent on a run.
 *
 * In-memory messages carry UI-only metadata (persisted sources/navigation) and,
 * after a session restore, attachment parts whose data was stripped before
 * saving. The wire copy drops metadata, turns stripped attachments into a text
 * note, clamps tool contents to `LIMITS.maxToolMessageChars` and keeps the
 * newest whole turns within `LIMITS.maxMessages` (a turn starts at a user
 * message, so the list never opens on an orphan tool result).
 *
 * @module assistant/thread/wire
 */
import { LIMITS } from '../contract'
import type { ContentPart, Message } from '@ag-ui/core'

/** A part whose data was removed before saving (see sessions/serialize). */
function isStrippedPart(part: ContentPart): boolean {
  return part.type !== 'text' && part.source.type === 'data' && part.source.value === ''
}

/** Display name of an attachment part (metadata.name, else its type). */
export function attachmentName(part: ContentPart): string {
  const metadata: unknown = part.metadata
  if (typeof metadata === 'object' && metadata !== null && 'name' in metadata && typeof metadata.name === 'string') {
    return metadata.name
  }
  return part.type
}

function wireParts(parts: ContentPart[]): ContentPart[] {
  return parts.map((part) => (isStrippedPart(part)
    ? { type: 'text', text: `[attachment "${attachmentName(part)}" not available in restored conversation]` }
    : part))
}

function wireMessage(message: Message): Message {
  switch (message.role) {
    case 'user':
      return {
        id: message.id,
        role: 'user',
        content: typeof message.content === 'string' ? message.content : wireParts(message.content),
      }
    case 'assistant':
      return {
        id: message.id,
        role: 'assistant',
        ...(message.content !== undefined ? { content: message.content } : {}),
        // Opaque signed thinking for the server's resume (see thread/reducer):
        // forwarded unchanged, never inspected.
        ...(message.encryptedValue !== undefined ? { encryptedValue: message.encryptedValue } : {}),
        ...(message.toolCalls && message.toolCalls.length > 0
          ? { toolCalls: message.toolCalls.map((c) => ({ id: c.id, type: 'function', function: c.function })) }
          : {}),
      }
    case 'tool':
      return {
        id: message.id,
        role: 'tool',
        toolCallId: message.toolCallId,
        content: typeof message.content === 'string' ? message.content.slice(0, LIMITS.maxToolMessageChars) : message.content,
      }
    default:
      return message
  }
}

/** Index of the first user message at or after `from`, or -1. */
function nextUserIndex(messages: readonly Message[], from: number): number {
  return messages.findIndex((m, i) => i >= from && m.role === 'user')
}

/**
 * Split messages into groups that must stay together: an assistant message
 * with the tool results that answer it (anything else is its own group).
 */
function toolGroups(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (message.role === 'tool' && last !== undefined) last.push(message)
    else groups.push([message])
  }
  return groups
}

/** The newest whole groups that fit `budget` messages (always at least the newest group). */
function newestGroups(messages: readonly Message[], budget: number): Message[] {
  const kept = toolGroups(messages).reduceRight<{ groups: Message[][]; size: number; full: boolean }>((acc, group) => {
    if (acc.full || (acc.groups.length > 0 && acc.size + group.length > budget)) return { ...acc, full: true }
    return { groups: [group, ...acc.groups], size: acc.size + group.length, full: false }
  }, { groups: [], size: 0, full: false })
  return kept.groups.flat()
}

/**
 * Keep the newest whole turns so the list fits `max` messages. When the newest
 * turn alone is longer than `max`, keep its user message and clamp inside the
 * turn by whole assistant+tool groups (oldest dropped first), so the list still
 * opens on the user's request and no tool result loses its call.
 */
export function keepNewestTurns(messages: readonly Message[], max: number): Message[] {
  if (messages.length <= max) return [...messages]
  const start = nextUserIndex(messages, messages.length - max)
  if (start !== -1) return messages.slice(start)
  const lastUser = messages.reduce((found, m, i) => (m.role === 'user' ? i : found), -1)
  const userMessage = messages.at(lastUser)
  if (lastUser === -1 || userMessage === undefined) return newestGroups(messages, max)
  return [userMessage, ...newestGroups(messages.slice(lastUser + 1), max - 1)]
}

export function toWireMessages(messages: readonly Message[]): Message[] {
  return keepNewestTurns(
    messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'),
    LIMITS.maxMessages,
  ).map(wireMessage)
}
