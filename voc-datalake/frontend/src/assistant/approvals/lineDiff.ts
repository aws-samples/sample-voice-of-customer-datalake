/**
 * @fileoverview A small line diff for the `update_document` approval preview.
 *
 * Longest-common-subsequence over lines, after trimming the common prefix and
 * suffix (which is what makes the typical "edit one section" case cheap). The DP
 * table is capped by {@link MAX_DIFF_CELLS}: past it the caller gets
 * `{ status: 'too-large' }` and falls back to a side-by-side excerpt instead of
 * freezing the tab on a 200k-character document.
 *
 * No dependency: the input is bounded, the output is only for a human preview,
 * and the one property that matters — applying the diff to `before` yields
 * `after` — is pinned by `lineDiff.test.ts`.
 *
 * @module assistant/approvals/lineDiff
 */

type DiffLineKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export type LineDiffResult =
  | { status: 'ok'; lines: DiffLine[]; added: number; removed: number }
  | { status: 'too-large' }

/** Upper bound on the LCS table (rows × columns) after prefix/suffix trimming. */
const MAX_DIFF_CELLS = 4_000_000

/** Upper bound on the raw input, checked before splitting. */
export const MAX_DIFF_CHARS = 400_000

function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n')
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length)
  const index = Array.from({ length: limit }, (_, i) => i).find((i) => a[i] !== b[i])
  return index ?? limit
}

function commonSuffixLength(a: readonly string[], b: readonly string[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix
  const index = Array.from({ length: limit }, (_, i) => i)
    .find((i) => a[a.length - 1 - i] !== b[b.length - 1 - i])
  return index ?? limit
}

/** One LCS cell; out-of-range reads are 0, the table's own boundary value. */
function cell(table: Uint32Array, index: number): number {
  return table[index] ?? 0
}

/** LCS lengths, row-major, (n+1) × (m+1), filled from the bottom-right. */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  // Built once and reused for every row: `let` loop counters are banned by lint.
  const columns = Array.from({ length: m }, (_, k) => m - 1 - k)
  for (const i of Array.from({ length: n }, (_, k) => n - 1 - k)) {
    for (const j of columns) {
      table[i * width + j] = a[i] === b[j]
        ? cell(table, (i + 1) * width + j + 1) + 1
        : Math.max(cell(table, (i + 1) * width + j), cell(table, i * width + j + 1))
    }
  }
  return table
}

function backtrack(a: readonly string[], b: readonly string[], table: Uint32Array): DiffLine[] {
  const width = b.length + 1
  const out: DiffLine[] = []
  const pos = { i: 0, j: 0 }
  while (pos.i < a.length && pos.j < b.length) {
    const left = a[pos.i] ?? ''
    const right = b[pos.j] ?? ''
    if (left === right) {
      out.push({ kind: 'same', text: left })
      pos.i += 1
      pos.j += 1
    } else if (cell(table, (pos.i + 1) * width + pos.j) >= cell(table, pos.i * width + pos.j + 1)) {
      out.push({ kind: 'del', text: left })
      pos.i += 1
    } else {
      out.push({ kind: 'add', text: right })
      pos.j += 1
    }
  }
  a.slice(pos.i).forEach((text) => out.push({ kind: 'del', text }))
  b.slice(pos.j).forEach((text) => out.push({ kind: 'add', text }))
  return out
}

/** Diff two texts line by line. */
export function diffLines(before: string, after: string): LineDiffResult {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return { status: 'too-large' }
  const a = splitLines(before)
  const b = splitLines(after)
  const prefix = commonPrefixLength(a, b)
  const suffix = commonSuffixLength(a, b, prefix)
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) return { status: 'too-large' }

  const middle = backtrack(midA, midB, lcsTable(midA, midB))
  const lines: DiffLine[] = [
    ...a.slice(0, prefix).map((text): DiffLine => ({ kind: 'same', text })),
    ...middle,
    ...a.slice(a.length - suffix).map((text): DiffLine => ({ kind: 'same', text })),
  ]
  return {
    status: 'ok',
    lines,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  }
}

export type DiffHunkItem = DiffLine | { kind: 'skip'; count: number }

/**
 * Collapse runs of unchanged lines longer than `2 × context` into a `skip`
 * marker, keeping `context` lines of each side around every change.
 */
export function collapseUnchanged(lines: readonly DiffLine[], context = 2): DiffHunkItem[] {
  const changed = lines.map((l) => l.kind !== 'same')
  const keep = lines.map((_, i) => {
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    return changed.slice(from, to + 1).some(Boolean)
  })
  // Push-based (not spread-per-line) so a long document stays linear.
  const out: DiffHunkItem[] = []
  lines.forEach((line, i) => {
    const last = out.at(-1)
    if (keep[i]) out.push(line)
    else if (last?.kind === 'skip') last.count += 1
    else out.push({ kind: 'skip', count: 1 })
  })
  return out
}
