/**
 * @fileoverview The focus group of the last turn, read back from its stored state so Regenerate runs it again.
 *
 * The stream ends a focus group with CUSTOM `assistant.focus_group` on the turn's last assistant message, and the
 * session keeps it there (`metadata.voc.focusGroup`), with the configuration the group was started with: the same
 * personas, rounds, documents and library items answer the same topic (the user message) again.
 *
 * @module assistant/runtime/focusGroupOfTurn
 */
import type { FocusGroup } from '@stream/assistant/contract'
import type { ThreadState } from '../thread/types'

export function focusGroupOfLastTurn(thread: Pick<ThreadState, 'messages' | 'focusGroups'>): FocusGroup | undefined {
  const lastUser = thread.messages.reduce((found, message, index) => (message.role === 'user' ? index : found), -1)
  const answers = thread.messages.slice(lastUser + 1).filter((message) => message.role === 'assistant')
  const stored = answers.flatMap((message) => (Object.hasOwn(thread.focusGroups, message.id)
    ? [thread.focusGroups[message.id]] : []))
  return stored.at(-1)?.config
}
