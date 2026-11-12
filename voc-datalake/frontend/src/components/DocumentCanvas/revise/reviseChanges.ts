/**
 * @fileoverview The pure rules of "Revise from comments" on the canvas (docs/document-review.md): which threads a pass
 * may take, how one proposed change goes into the draft, and which threads a saved version answers.
 *
 * A change's `before` is an exact passage of the version the pass read. It goes into the draft only while it still
 * occurs there exactly once: then that one occurrence is replaced by `after`. Edited away (or now ambiguous), the
 * change is "out of date" and cannot be accepted. Accepted, it is tracked by where its new text went (`Placed`), so a
 * save counts it kept only while that very occurrence is still there.
 *
 * @module components/DocumentCanvas/revise/reviseChanges
 */
import { commonPrefixLength } from '../../../utils/commonPrefix'
import type { CommentThread, ReviseChange } from '../../../api/documentReviewSchema'

/** How often `needle` occurs in `text` (non-overlapping; an empty needle never does). */
function occurrences(text: string, needle: string): number {
  return needle === '' ? 0 : text.split(needle).length - 1
}

/** The change's `before` no longer occurs exactly once in the draft: it cannot be accepted. */
export function isOutOfDate(draft: string, change: ReviseChange): boolean {
  return occurrences(draft, change.before) !== 1
}

/** The draft with the change's one `before` replaced by its `after`; null when it is out of date. */
export function applyChange(draft: string, change: ReviseChange): string | null {
  if (isOutOfDate(draft, change)) return null
  const at = draft.indexOf(change.before)
  return draft.slice(0, at) + change.after + draft.slice(at + change.before.length)
}

/**
 * The threads a pass takes by default (the server's own rule, shown before asking): resolved, or open with at least
 * one reply, and not yet addressed. Whether a quote is still found is the server's to judge (it reads the stored text).
 */
export function threadsToConsider(threads: readonly CommentThread[]): readonly CommentThread[] {
  return threads.filter((thread) => thread.addressed === null && (thread.status === 'resolved' || thread.replies.length > 0))
}

/**
 * Where the accepted changes' new text sits in a draft: `draft` is the text they were last placed in (the draft put
 * into the editor), `at` each change's offset of its `after` in it.
 */
export interface Placed {
  readonly draft: string
  readonly at: Readonly<Record<string, { readonly after: string; readonly offset: number }>>
}

export const NOTHING_PLACED: Placed = { draft: '', at: {} }

/** How much of the text on each side of a change identifies its occurrence, and how much of it must still match. */
const CONTEXT = 32
const MIN_CONTEXT = 8

// By UTF-16 unit, as the offsets are.
const reversed = (text: string): string => Array.from({ length: text.length }, (_, i) => text.charAt(text.length - 1 - i)).join('')

/** Every offset at which `needle` starts in `text`, overlapping ones too. */
function offsetsOf(text: string, needle: string, from = 0, found: number[] = []): readonly number[] {
  const at = text.indexOf(needle, from)
  if (at === -1) return found
  found.push(at)
  return offsetsOf(text, needle, at + 1, found)
}

interface Candidate { readonly at: number; readonly score: number; readonly distance: number }

const better = (a: Candidate, b: Candidate): boolean => a.score > b.score || (a.score === b.score && a.distance < b.distance)

/**
 * The offset in `text` of the occurrence of `after` that was at `offset` in `draft`, or null when `text` no longer
 * holds it. A candidate must have the nearest characters on both sides as they were (up to MIN_CONTEXT; at the start
 * or the end of the draft, that same edge); the one with the most surroundings in common wins, then the nearest.
 */
export function locatePlaced(after: string, offset: number, draft: string, text: string): number | null {
  const left = draft.slice(Math.max(0, offset - CONTEXT), offset)
  const right = draft.slice(offset + after.length, offset + after.length + CONTEXT)
  const needLeft = Math.min(MIN_CONTEXT, left.length)
  const needRight = Math.min(MIN_CONTEXT, right.length)
  const needle = left.slice(left.length - needLeft) + after + right.slice(0, needRight)
  if (needle === '') return null
  const candidates = offsetsOf(text, needle).flatMap((found): Candidate[] => {
    const at = found + needLeft
    const end = at + after.length
    // A side the draft's edge was within MIN_CONTEXT of is still that edge.
    const atEdges = (left.length >= MIN_CONTEXT || at === left.length)
      && (right.length >= MIN_CONTEXT || end + right.length === text.length)
    if (!atEdges) return []
    const score = commonPrefixLength(reversed(text.slice(Math.max(0, at - CONTEXT), at)), reversed(left))
      + commonPrefixLength(text.slice(end, end + CONTEXT), right)
    return [{ at, score, distance: Math.abs(at - offset) }]
  })
  const best = candidates.reduce<Candidate | null>((top, candidate) => (top === null || better(candidate, top) ? candidate : top), null)
  return best?.at ?? null
}

/** Every placed change followed into `text`; one `text` no longer holds is dropped. */
export function relocate(placed: Placed, text: string): Placed {
  if (placed.draft === text) return placed
  const at = Object.fromEntries(Object.entries(placed.at).flatMap(([id, { after, offset }]) => {
    const moved = locatePlaced(after, offset, placed.draft, text)
    return moved === null ? [] : [[id, { after, offset: moved }]]
  }))
  return { draft: text, at }
}

/** The change put into `placed`'s draft (see applyChange), tracked from there on; null when it is out of date. */
export function placeChange(placed: Placed, change: ReviseChange): Placed | null {
  const text = applyChange(placed.draft, change)
  if (text === null) return null
  const offset = placed.draft.indexOf(change.before)
  const others = relocate(placed, text)
  return { draft: text, at: { ...others.at, [change.change_id]: { after: change.after, offset } } }
}

/**
 * The accepted changes a saved text kept: those whose own occurrence of their new text it still holds (see locatePlaced;
 * a deletion: the join where its old text was). A change discarded or typed over before the save is not kept.
 */
export function keptChanges(accepted: readonly ReviseChange[], placed: Placed, saved: string): readonly ReviseChange[] {
  const followed = relocate(placed, saved)
  return accepted.filter((change) => followed.at[change.change_id] !== undefined)
}

/** The threads some changes answer, each once. */
export const threadIdsOf = (changes: readonly ReviseChange[]): readonly string[] =>
  [...new Set(changes.flatMap((change) => change.thread_ids))]
