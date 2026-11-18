/**
 * @fileoverview An agent's thread as the workspace keeps it (7.51.00): the pages the server answers merged into one
 * list, each item once by its `ref`, in time order, and how each item reads in the Slack-like thread.
 *
 * A page may repeat items: the server re-reads the conversation's tail window on every page, and a tool call's result
 * that lands on a later page comes back as an update with the call's own `ref`. So an item is kept by its ref and a
 * later one with the same ref REPLACES it, in place (its first place breaks ties in time).
 *
 * Every text is bounded again here ({@link MAX_ITEM_TEXT}): the server cuts at 4 KB, and the page never trusts a
 * transcript's size (bridge doc S8); it is rendered as Markdown with no raw HTML (ThreadItem.tsx).
 *
 * @module pages/Agents/RunWorkspace/threadModel
 */
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

/** The longest text an item shows, in UTF-16 units (the server's 4 KB, with room for multi-byte text). */
export const MAX_ITEM_TEXT = 4096
/** A sender's items within this long of the one before read as one message group (no header of their own). */
const GROUP_MS = 5 * 60 * 1000

/** What the workspace knows of a thread: its items, where the next page starts, and whether it has ended. */
export interface ThreadState {
  readonly items: readonly ThreadItem[]
  readonly next: string | null
  readonly done: boolean
  /** The last page was a full one: more is waiting now, so the next read comes sooner. */
  readonly full: boolean
}

export const EMPTY_THREAD: ThreadState = { items: [], next: null, done: false, full: false }

/** `known` with `page` merged in: each ref once (the later item in the earlier's place), ordered by time. */
export function mergeThread(known: readonly ThreadItem[], page: readonly ThreadItem[]): ThreadItem[] {
  const byRef = new Map<string, { item: ThreadItem; seen: number }>()
  for (const item of [...known, ...page]) {
    const earlier = byRef.get(item.ref)
    byRef.set(item.ref, { item, seen: earlier?.seen ?? byRef.size })
  }
  return [...byRef.values()]
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.seen - b.seen)
    .map(({ item }) => item)
}

/** How an item reads in the thread. */
export type ItemLook = 'said' | 'thought' | 'tool' | 'folded' | 'message' | 'steer' | 'event'

/**
 * An item's look: the agent's words (Markdown), its thinking (collapsed), a tool call (one line), the harness's
 * messages to the model (folded: the task and the platform's notes, ACP's user message chunks), the conversation's
 * messages, a person's steering, or a run event on one line (gate, finding, signal, checkpoint, crash, end). An
 * unknown kind reads as an event, by its name.
 */
export function lookOf(item: ThreadItem): ItemLook {
  switch (item.kind) {
    case 'said': return 'said'
    case 'thought': return 'thought'
    case 'tool': return 'tool'
    case 'steer': return 'steer'
    case 'message':
      return item.from.kind === 'system' && item.from.id === 'harness' ? 'folded' : 'message'
    default:
      return 'event'
  }
}

/** The looks that are the agent's own words or thinking: a reply reads as a message, never as one more tool line. */
const WORDS: ReadonlySet<ItemLook> = new Set(['said', 'thought'])

/**
 * Whether `item` starts a new message group (Slack's sender and time line): another sender, a pause since, or
 * (7.54.00) the agent's words or thinking after its tool calls or the run's events, so each reply carries who said
 * it and when.
 */
export function startsGroup(previous: ThreadItem | undefined, item: ThreadItem): boolean {
  if (previous === undefined) return true
  if (previous.from.kind !== item.from.kind || previous.from.id !== item.from.id) return true
  if (WORDS.has(lookOf(item)) && !WORDS.has(lookOf(previous))) return true
  const gap = Date.parse(item.at) - Date.parse(previous.at)
  return !(gap >= 0 && gap <= GROUP_MS)
}

/** (7.54.00) The thread without the agent's thinking, as shown while the person has "Show thinking" off. */
export function withoutThinking<T extends { readonly item: ThreadItem }>(items: readonly T[]): readonly T[] {
  return items.filter((entry) => lookOf(entry.item) !== 'thought')
}

/** A text longer than this many characters, or lines, opens folded with "Show more" (7.54.00). */
export const LONG_TEXT_CHARS = 700
export const LONG_TEXT_LINES = 10

/** Whether a text is long enough to open folded behind "Show more". */
export function isLongText(text: string): boolean {
  return text.length > LONG_TEXT_CHARS || text.split('\n').length > LONG_TEXT_LINES
}

/** `text` bounded to {@link MAX_ITEM_TEXT}, and whether it was cut here or by the server. */
export function boundedText(item: Pick<ThreadItem, 'text' | 'cut'>): { text: string; cut: boolean } {
  const over = item.text.length > MAX_ITEM_TEXT
  return { text: over ? item.text.slice(0, MAX_ITEM_TEXT) : item.text, cut: item.cut || over }
}
