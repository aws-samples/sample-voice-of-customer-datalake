/**
 * @fileoverview Compare and merge, after a stale save (D6-4): the changes the latest version made to the version this
 * draft was written on, block by block, each judged against the draft by Revise's rule (exactly once): a change
 * applies only while the passage it replaces occurs exactly once in the draft, and that one occurrence is replaced.
 * A change the draft already holds is "already in your draft"; any other is a true conflict, shown side by side and
 * never applied. Pure: the surface takes the chosen ones into the draft, on top of the latest version.
 *
 * @module components/Document/diff/merge
 */
import { diffBlocks } from './lineDiff'
import type { DiffLine } from './lineDiff'

/** Where a change of theirs stands against the draft. */
type MergeStatus = 'applies' | 'already' | 'conflict'

export interface MergeChange {
  readonly id: string
  /** The passage of the version the draft was written on that the change replaces (with a neighbour as an anchor). */
  readonly before: string
  /** What the latest version has there instead. */
  readonly after: string
  readonly status: MergeStatus
}

/** `needle` occurs at exactly one place in `text` (overlapping places count); an empty needle occurs nowhere. */
export function occursOnce(text: string, needle: string): boolean {
  const first = text.indexOf(needle)
  return needle !== '' && first !== -1 && !text.slice(first + 1).includes(needle)
}

/** `text` with the one occurrence of `change.before` replaced by `change.after`; null when it is not exactly once. */
export function applyOnce(text: string, change: { readonly before: string; readonly after: string }): string | null {
  if (!occursOnce(text, change.before)) return null
  const at = text.indexOf(change.before)
  return text.slice(0, at) + change.after + text.slice(at + change.before.length)
}

const BLOCK_GAP = '\n\n'

interface Hunk { readonly start: number; readonly removed: readonly string[]; readonly added: readonly string[] }
interface OpenHunk { readonly start: number; readonly removed: string[]; readonly added: string[] }

/** The runs of changed blocks, each with where it starts among the base's blocks. */
function hunksOf(lines: readonly DiffLine[]): Hunk[] {
  const hunks: Hunk[] = []
  const at: { base: number; open: OpenHunk | null } = { base: 0, open: null }
  for (const line of lines) {
    if (line.kind === 'same') {
      if (at.open !== null) hunks.push(at.open)
      at.open = null
      at.base += 1
      continue
    }
    at.open ??= { start: at.base, removed: [], added: [] }
    if (line.kind === 'del') {
      at.open.removed.push(line.text)
      at.base += 1
    } else {
      at.open.added.push(line.text)
    }
  }
  if (at.open !== null) hunks.push(at.open)
  return hunks
}

/**
 * The hunk as one replacement over the base: its removed blocks, widened by the neighbouring unchanged blocks until
 * the passage names one place in the base (an insertion or a removal always takes a neighbour, so the blank lines
 * around it stay right).
 */
function replacementOf(hunk: Hunk, blocks: readonly string[], base: string): { before: string; after: string } {
  const previous = hunk.start > 0 ? blocks[hunk.start - 1] : undefined
  const next = blocks[hunk.start + hunk.removed.length]
  const windows: { lead: string[]; tail: string[] }[] = [
    { lead: [], tail: [] },
    { lead: previous === undefined ? [] : [previous], tail: [] },
    { lead: previous === undefined ? [] : [previous], tail: next === undefined ? [] : [next] },
    { lead: [], tail: next === undefined ? [] : [next] },
  ]
  const fits = (window: { lead: string[]; tail: string[] }) => {
    const before = [...window.lead, ...hunk.removed, ...window.tail].join(BLOCK_GAP)
    const anchored = hunk.removed.length > 0 && hunk.added.length > 0 ? true : window.lead.length + window.tail.length > 0
    return anchored && occursOnce(base, before)
  }
  const chosen = windows.find(fits) ?? windows[2] ?? { lead: [], tail: [] }
  return {
    before: [...chosen.lead, ...hunk.removed, ...chosen.tail].join(BLOCK_GAP),
    after: [...chosen.lead, ...hunk.added, ...chosen.tail].join(BLOCK_GAP),
  }
}

/** Split Markdown into blocks the way the block diff does (the diff's own unchanged lines). */
function baseBlocks(lines: readonly DiffLine[]): string[] {
  return lines.filter((line) => line.kind !== 'add').map((line) => line.text)
}

/** How one change of the latest version stands against `mine`: its old text there once, its new text there once, or neither. */
function statusIn(mine: string, before: string, after: string): MergeStatus {
  if (occursOnce(mine, before)) return 'applies'
  return occursOnce(mine, after) ? 'already' : 'conflict'
}

/**
 * The latest version's changes over `base`, each judged against `mine`; null when the texts are too large to compare
 * (lineDiff's caps): the surface then offers the side-by-side compare and the two other ways out only.
 */
export function mergeChanges(base: string, theirs: string, mine: string): readonly MergeChange[] | null {
  const diff = diffBlocks(base, theirs)
  if (diff.status === 'too-large') return null
  const blocks = baseBlocks(diff.lines)
  return hunksOf(diff.lines).map((hunk, index): MergeChange => {
    const { before, after } = replacementOf(hunk, blocks, base)
    return { id: `change-${String(index + 1)}`, before, after, status: statusIn(mine, before, after) }
  })
}

/** `mine` with the taken changes applied in order, each by the exactly-once rule; those that no longer apply are left. */
export function takeChanges(mine: string, changes: readonly MergeChange[]): { readonly text: string; readonly taken: readonly string[] } {
  return changes.reduce<{ text: string; taken: string[] }>((merged, change) => {
    const next = change.status === 'applies' ? applyOnce(merged.text, change) : null
    return next === null ? merged : { text: next, taken: [...merged.taken, change.id] }
  }, { text: mine, taken: [] })
}
