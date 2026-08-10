/**
 * Shared rules for the conversation history sent to the streaming chat API.
 *
 * Both chat surfaces (the VOC chat page `Chat.tsx` and the project chat tab
 * `ChatTab.tsx`) post to the same `/chat/stream` endpoint, so both are bound
 * by the same server-side contract.  Keeping the rules here means the two
 * callers cannot drift.
 */

/**
 * Maximum number of history messages sent to the streaming server.
 *
 * Must stay at or below the server-side cap defined in
 * `lambda/stream/src/schema.ts` (`history: z.array(…).max(50)`).
 * If the server cap is raised, update both files in the same PR.
 * We keep the *newest* entries so the model always sees the most
 * recent turns.
 *
 * `constants/chat.test.ts` reads the server schema and fails if this value
 * ever exceeds it, so the coupling is checked rather than merely documented.
 */
export const MAX_HISTORY_ENTRIES = 50

/** A single history entry as the streaming API expects it. */
export interface HistoryEntry {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Separator used when collapsing a run of same-role messages into one. */
const MERGED_CONTENT_SEPARATOR = '\n\n'

/**
 * Collapse runs of consecutive same-role messages into a single entry.
 *
 * Needed because the project chat stores one assistant message *per persona*
 * in roundtable mode (`buildRoundtableMessages`), which would otherwise send
 * several assistant turns in a row.
 */
function mergeSameRoleRuns(messages: readonly HistoryEntry[]): HistoryEntry[] {
  return messages.reduce<HistoryEntry[]>((merged, message) => {
    const lastIndex = merged.length - 1
    if (merged.length > 0 && merged[lastIndex].role === message.role) {
      const previous = merged[lastIndex]
      merged[lastIndex] = {
        role: previous.role,
        content: `${previous.content}${MERGED_CONTENT_SEPARATOR}${message.content}`,
      }
      return merged
    }
    return [...merged, {
      role: message.role,
      content: message.content,
    }]
  }, [])
}

/**
 * Build the `history` payload for a chat request from stored conversation
 * messages.
 *
 * The server maps history 1:1 into Bedrock Converse messages
 * (`historyToBedrockMessages` in `lambda/stream/src/handler.ts`) and does not
 * repair the list, while Bedrock requires it to start with a user turn and to
 * strictly alternate roles.  Anything invalid becomes a `ValidationException`
 * that the user sees as an opaque error, so the repair has to happen here:
 *
 * 1. Merge runs of consecutive same-role messages (roundtable personas).
 * 2. Drop a trailing *unanswered* user turn — the caller sends the new user
 *    message separately, so keeping it would produce two user turns in a row.
 *    This happens whenever a stream was cancelled before any reply was saved.
 * 3. Cap the length to {@link MAX_HISTORY_ENTRIES}, keeping the newest turns.
 * 4. Drop leading non-user entries, because `slice` from the tail can land on
 *    an assistant turn.
 *
 * The result is always ≤ {@link MAX_HISTORY_ENTRIES} entries, starts with a
 * user turn (or is empty) and has strictly alternating roles.
 */
export function buildHistory(messages: readonly HistoryEntry[]): HistoryEntry[] {
  const merged = mergeSameRoleRuns(messages)
  const endsWithUnansweredUser = merged.length > 0 && merged[merged.length - 1].role === 'user'
  const answered = endsWithUnansweredUser ? merged.slice(0, -1) : merged
  const capped = answered.slice(-MAX_HISTORY_ENTRIES)
  const firstUserIndex = capped.findIndex((entry) => entry.role === 'user')
  return firstUserIndex === -1 ? [] : capped.slice(firstUserIndex)
}
