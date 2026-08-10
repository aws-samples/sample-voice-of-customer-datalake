/**
 * Shared rules for the conversation history sent to the streaming chat API.
 *
 * The two streaming surfaces (the VOC chat page `Chat.tsx` and the project chat
 * tab `ChatTab.tsx`) post to the same `/chat/stream` endpoint, so both are
 * bound by the same server-side contract.  The product interview
 * (`ProductTab.tsx`) posts elsewhere, but its history reaches Bedrock Converse
 * through the same 1:1 mapping and so owes the same shape.  Every call site
 * that assembles history goes through {@link buildHistory}, so no path can
 * keep producing the shape this module exists to prevent.
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

/**
 * Maximum number of history turns sent to the product-context interview.
 *
 * The interview is a different endpoint with a tighter server-side window:
 * `interview_turn` in `voc-datalake/lambda/api/product_context.py` keeps only
 * `history[-12:]`.  Sending more is silently discarded, so cap here instead.
 *
 * It matches the server window exactly; any positive value is safe as far as
 * {@link buildHistory} is concerned (see its `@param maxEntries`).
 */
export const MAX_INTERVIEW_HISTORY_ENTRIES = 12

/** A single history entry as the streaming API expects it. */
export interface HistoryEntry {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Separator used when collapsing a run of assistant messages into one. */
const MERGED_CONTENT_SEPARATOR = '\n\n'

/**
 * Collapse runs of consecutive *assistant* messages into a single entry.
 *
 * Needed because the project chat stores one assistant message *per persona*
 * in roundtable mode (`buildRoundtableMessages`), which would otherwise send
 * several assistant turns in a row.  The whole run is one logical reply to the
 * preceding question, so the contents are joined rather than discarded.
 *
 * Consecutive *user* messages are deliberately NOT merged — see
 * `dropUnansweredUserTurns`, which drops them instead.  Joining two questions
 * the user asked separately would attribute both to a single turn.
 */
function mergeAssistantRuns(messages: readonly HistoryEntry[]): HistoryEntry[] {
  const merged: HistoryEntry[] = []
  for (const message of messages) {
    const last = merged.length - 1
    if (merged.length > 0 && merged[last].role === 'assistant' && message.role === 'assistant') {
      merged[last] = {
        role: 'assistant',
        content: `${merged[last].content}${MERGED_CONTENT_SEPARATOR}${message.content}`,
      }
      continue
    }
    merged.push({
      role: message.role,
      content: message.content,
    })
  }
  return merged
}

/**
 * Drop every user turn that never received a reply, wherever it sits.
 *
 * A user turn is "answered" only when an assistant turn follows it directly.
 * Two cases produce unanswered turns, and both must be removed or Bedrock
 * receives consecutive user turns:
 *
 * - **Trailing**: the caller sends the new user message separately, and a
 *   cancelled stream leaves its question stored with no reply.
 * - **Interior**: a cancelled question followed by a question the user then
 *   asked and got answered.  Merging these instead would silently glue an
 *   abandoned question onto a real one and attribute both to the same turn.
 *
 * Run after {@link mergeAssistantRuns} so "followed by an assistant turn" is
 * decided against merged runs.  Removing an unanswered user turn can never
 * create a new assistant/assistant pair: a user turn sitting between two
 * assistant turns is by definition answered, so it is kept.
 */
function dropUnansweredUserTurns(messages: readonly HistoryEntry[]): HistoryEntry[] {
  return messages.filter((message, index) => (
    message.role !== 'user' || messages[index + 1]?.role === 'assistant'
  ))
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
 * 1. Merge runs of consecutive assistant messages (roundtable personas) so a
 *    multi-persona reply becomes the single logical turn it represents.
 * 2. Drop every *unanswered* user turn, trailing or interior — a cancelled
 *    question, or the question the caller is about to send separately.
 * 3. Cap the length to {@link MAX_HISTORY_ENTRIES}, keeping the newest turns.
 * 4. Drop leading non-user entries.  This guards a conversation whose first
 *    stored entry is an assistant turn — a transcript restored from
 *    `localStorage` whose opening user turn was pruned, or the greeting-first
 *    product interview.  It is deliberately *not* about the cap boundary: with
 *    an even cap that boundary is unreachable, because steps 1-2 leave a
 *    strictly alternating list ending in an assistant turn, so `slice` from the
 *    tail lands on a user turn.  Keep this step anyway — the guarantee it
 *    provides is about the *input* shape, which callers control and this module
 *    does not.
 *
 * The result is always ≤ `maxEntries` entries, starts with a user turn (or is
 * empty) and has strictly alternating roles.
 *
 * @param messages Stored conversation messages, oldest first.
 * @param maxEntries Cap for surfaces with a tighter server window than
 *   `/chat/stream` — see {@link MAX_INTERVIEW_HISTORY_ENTRIES}.  Any positive
 *   value is safe: an odd cap can slice onto an assistant turn, but step 4
 *   trims it unconditionally on the very next line, so evenness is an
 *   optimisation (step 4 has nothing to do) and not a precondition.
 */
export function buildHistory(
  messages: readonly HistoryEntry[],
  maxEntries: number = MAX_HISTORY_ENTRIES,
): HistoryEntry[] {
  const answered = dropUnansweredUserTurns(mergeAssistantRuns(messages))
  const capped = answered.slice(-maxEntries)
  const firstUserIndex = capped.findIndex((entry) => entry.role === 'user')
  return firstUserIndex === -1 ? [] : capped.slice(firstUserIndex)
}
