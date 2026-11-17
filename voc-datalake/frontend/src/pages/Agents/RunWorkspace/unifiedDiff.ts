/**
 * @fileoverview The Changes tab's own unified-diff parser (7.51.00, D51-2: no diff library; we parse patches, we
 * never compute them, like assistant/approvals/lineDiff.ts). A patch's text becomes its files (git's headers read:
 * renames, copies, binary, mode changes, `/dev/null` for an added or deleted side, quoted paths), each with its hunks
 * and numbered lines (`\ No newline at end of file` marks the line before it); then the runs of unchanged context
 * folded, the rows of the split view paired, and a mode change said in words.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/DiffBlock.tsx` (`extractFilePath`: `+++ b/` preferred,
 * `/dev/null` skipped, a path ending at a tab, never at a space, and nothing read past the first `@@`) and
 * `website/src/components/FoldableDiffBlock.tsx` (the fold of long context), and DiffBlock's `modeWords` (a mode change
 * in words), Apache-2.0 (THIRD-PARTY-LICENSES.md).
 *
 * @module pages/Agents/RunWorkspace/unifiedDiff
 */

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
  readonly oldNo: number | null
  readonly newNo: number | null
  /** `\ No newline at end of file` followed it. */
  noNewline: boolean
}

export interface DiffHunk {
  readonly header: string
  readonly lines: DiffLine[]
}

export type DiffStatus = 'added' | 'deleted' | 'renamed' | 'copied' | 'modified'

export interface DiffFile {
  /** The file's path (its new side; the old one for a deletion). */
  readonly path: string
  /** The old path of a rename or a copy, else null. */
  readonly oldPath: string | null
  readonly status: DiffStatus
  readonly binary: boolean
  readonly modeChange: { readonly from: string; readonly to: string } | null
  readonly hunks: readonly DiffHunk[]
  readonly additions: number
  readonly deletions: number
}

/** A run of lines shown, or a run of unchanged ones folded away. */
export type DiffSegment = { readonly kind: 'lines'; readonly lines: readonly DiffLine[] } | { readonly kind: 'fold'; readonly lines: readonly DiffLine[] }

/** One row of the split view: the old side's line and the new side's (null: nothing on that side). */
export interface SplitRow {
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

const DEV_NULL = '/dev/null'
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const QUOTED_GIT = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/
/** Unchanged lines kept beside a change when a run of them is folded, and the fewest a fold hides. */
const FOLD_KEEP = 3
const FOLD_MIN = 4

/** A git-quoted path's text (`"a\tb"` → a, tab, b), or the text itself when it is not quoted. */
function unquoted(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw
  const escapes: Readonly<Record<string, string>> = { t: '\t', n: '\n', '"': '"', '\\': '\\' }
  return raw.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => escapes[char] ?? char)
}

/** A header's path: up to a tab, unquoted, its `a/` or `b/` prefix off; null for `/dev/null`. */
function headerPath(rest: string, prefix: 'a/' | 'b/'): string | null {
  const path = unquoted(rest.split('\t')[0] ?? '')
  if (path === DEV_NULL || path === '') return null
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** The header lines that name a file's path, in the order of preference (DiffBlock's `extractFilePath`). */
const HEADER_PATHS: ReadonlyArray<RegExp> = [
  /^\+\+\+ b\/(.+?)(?:\t|$)/, /^\+\+\+ (\S.*?)(?:\t|$)/, /^--- a\/(.+?)(?:\t|$)/, /^--- (\S.*?)(?:\t|$)/, /^diff --git a\/.+ b\/(.+)/,
]
/** What a header says when it names no file: an added or deleted side, a bare marker. */
const NO_PATH: ReadonlySet<string> = new Set([DEV_NULL, '-', '+'])

/**
 * The file a patch's headers name (DiffBlock's `extractFilePath`): `+++ b/<path>` first, then `+++ <path>`, `--- a/`,
 * `--- <path>` and `diff --git … b/<path>`; `/dev/null` is no path, and nothing after the first hunk is a header.
 */
export function extractFilePath(code: string): string | null {
  const found = new Map<number, string>()
  for (const line of code.split('\n')) {
    if (line.startsWith('@@')) break
    HEADER_PATHS.forEach((pattern, rank) => {
      const path = pattern.exec(line)?.[1]
      if (path !== undefined && !NO_PATH.has(path) && !found.has(rank)) found.set(rank, path)
    })
  }
  const best = [...found.keys()].sort((a, b) => a - b)[0]
  return best === undefined ? null : found.get(best) ?? null
}

interface Draft {
  headers: string[]
  oldPath: string | null
  newPath: string | null
  status: DiffStatus | null
  binary: boolean
  modeFrom: string
  modeTo: string
  sawMinus: boolean
  hunks: DiffHunk[]
  /** The open hunk's next line numbers and the lines it still holds on each side. */
  oldNo: number
  newNo: number
  oldLeft: number
  newLeft: number
}

/** A new file's draft from its first line (`diff --git a/X b/Y`, or a plain patch's `--- X`). */
function draftOf(line: string): Draft {
  const draft: Draft = {
    headers: [], oldPath: null, newPath: null, status: null, binary: false, modeFrom: '', modeTo: '',
    sawMinus: false, hunks: [], oldNo: 0, newNo: 0, oldLeft: 0, newLeft: 0,
  }
  if (!line.startsWith('diff --git ')) {
    headerLine(draft, line)
    return draft
  }
  draft.headers.push(line)
  const rest = line.slice('diff --git '.length)
  const quoted = QUOTED_GIT.exec(rest)
  const at = rest.lastIndexOf(' b/')
  const sides = quoted === null ? [rest.slice(0, Math.max(0, at)), rest.slice(at + 1)] : [`"a/${quoted[1] ?? ''}"`, `"b/${quoted[2] ?? ''}"`]
  draft.oldPath = headerPath(sides[0] ?? '', 'a/')
  draft.newPath = headerPath(sides[1] ?? '', 'b/')
  return draft
}

/** The status a header line says, if it says one. */
const HEADER_STATUS: ReadonlyArray<readonly [string, DiffStatus]> = [
  ['new file mode', 'added'], ['deleted file mode', 'deleted'], ['rename from ', 'renamed'], ['copy from ', 'copied'],
]

/** What each of git's header lines sets on the file (the first group is the line's value). */
const HEADER_READERS: ReadonlyArray<readonly [RegExp, (draft: Draft, value: string) => void]> = [
  [/^--- (.*)$/, (draft, value) => {
    draft.sawMinus = true
    draft.oldPath = headerPath(value, 'a/')
  }],
  [/^\+\+\+ (.*)$/, (draft, value) => { draft.newPath = headerPath(value, 'b/') }],
  [/^(?:rename|copy) from (.*)$/, (draft, value) => { draft.oldPath = unquoted(value) }],
  [/^(?:rename|copy) to (.*)$/, (draft, value) => { draft.newPath = unquoted(value) }],
  [/^old mode (.*)$/, (draft, value) => { draft.modeFrom = value }],
  [/^new mode (.*)$/, (draft, value) => { draft.modeTo = value }],
  [/^(Binary files .+ and .+ differ|GIT binary patch)$/, (draft) => { draft.binary = true }],
]

/** One line between a file's first line and its first hunk (or between hunks). */
function headerLine(draft: Draft, line: string): void {
  if (line.startsWith('@@')) {
    openHunk(draft, line, HUNK.exec(line))
    return
  }
  draft.headers.push(line)
  const status = HEADER_STATUS.find(([prefix]) => line.startsWith(prefix))?.[1]
  if (status !== undefined) draft.status = status
  for (const [pattern, read] of HEADER_READERS) {
    const value = pattern.exec(line)?.[1]
    if (value !== undefined) read(draft, value)
  }
}

function openHunk(draft: Draft, line: string, hunk: RegExpExecArray | null): void {
  const number = (index: number, fallback: number) => (hunk?.[index] === undefined ? fallback : Number(hunk[index]))
  draft.oldNo = number(1, 1)
  draft.newNo = number(3, 1)
  // A bare `@@` places nothing: its lines are counted from 1 and run until the next header.
  draft.oldLeft = hunk === null ? Infinity : number(2, 1)
  draft.newLeft = hunk === null ? Infinity : number(4, 1)
  draft.hunks.push({ header: line, lines: [] })
}

/** A hunk line's kind (an empty line is an unchanged empty line whose space a tool trimmed); null: no hunk line. */
function hunkKind(line: string): DiffLineKind | null {
  if (line === '' || line.startsWith(' ')) return 'context'
  if (line.startsWith('-')) return 'del'
  return line.startsWith('+') ? 'add' : null
}

function hunkLine(draft: Draft, kind: DiffLineKind, line: string): void {
  const old = kind === 'add' ? null : draft.oldNo
  const fresh = kind === 'del' ? null : draft.newNo
  draft.hunks.at(-1)?.lines.push({ kind, text: line.slice(1), oldNo: old, newNo: fresh, noNewline: false })
  if (old !== null) draft.oldNo += 1
  if (old !== null) draft.oldLeft -= 1
  if (fresh !== null) draft.newNo += 1
  if (fresh !== null) draft.newLeft -= 1
}

const isOpen = (draft: Draft | null) => draft !== null && draft.hunks.length > 0 && (draft.oldLeft > 0 || draft.newLeft > 0)

/** Whether `line` starts the next file: git's header, or a plain patch's `---` once this file has had its own. */
const startsFile = (line: string, draft: Draft | null) =>
  line.startsWith('diff --git ') || (line.startsWith('--- ') && (draft === null || draft.hunks.length > 0 || draft.sawMinus))

/**
 * A mode change in words, never as git's octal digits (DiffBlock's `modeWords`): the executable bit is the change a
 * reader meets, so it is named; a change of file type (a regular file becoming a symlink) or anything else is a mode
 * change.
 */
export function modeChangeKind({ from, to }: { readonly from: string; readonly to: string }): 'executable' | 'notExecutable' | 'changed' {
  const kind = (mode: string) => mode.slice(0, -3)
  const executable = (mode: string) => /[1357]/.test(mode.slice(-3))
  if (kind(from) !== kind(to) || executable(from) === executable(to)) return 'changed'
  return executable(to) ? 'executable' : 'notExecutable'
}

/** A file's status when no header said one: a side that is `/dev/null` was added or deleted. */
function statusOf(draft: Draft): DiffStatus {
  if (draft.status !== null) return draft.status
  if (draft.oldPath === null) return 'added'
  return draft.newPath === null ? 'deleted' : 'modified'
}

function fileOf(draft: Draft): DiffFile {
  const lines = draft.hunks.flatMap((hunk) => hunk.lines)
  const status = statusOf(draft)
  const path = draft.newPath ?? draft.oldPath ?? extractFilePath(draft.headers.join('\n')) ?? ''
  const moved = status === 'renamed' || status === 'copied'
  return {
    path, oldPath: moved ? draft.oldPath : null, status, binary: draft.binary,
    modeChange: draft.modeFrom !== '' && draft.modeTo !== '' ? { from: draft.modeFrom, to: draft.modeTo } : null,
    hunks: draft.hunks,
    additions: lines.filter((line) => line.kind === 'add').length,
    deletions: lines.filter((line) => line.kind === 'del').length,
  }
}

/** Read one line of a patch into `state`, closing a file into `files` when the next one starts. */
function readLine(state: { draft: Draft | null }, files: DiffFile[], line: string): void {
  const { draft } = state
  const kind = hunkKind(line)
  const last = draft?.hunks.at(-1)?.lines.at(-1)
  if (line.startsWith('\\') && last !== undefined) {
    last.noNewline = true
  } else if (draft !== null && isOpen(draft) && kind !== null && !line.startsWith('diff --git ')) {
    hunkLine(draft, kind, line)
  } else if (startsFile(line, draft)) {
    if (draft !== null) files.push(fileOf(draft))
    state.draft = draftOf(line)
  } else if (draft !== null) {
    headerLine(draft, line)
  }
}

/** A patch's files, in its order (anything before the first file, a commit's message, is skipped). */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  const state: { draft: Draft | null } = { draft: null }
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) readLine(state, files, line)
  return state.draft === null ? files : [...files, fileOf(state.draft)]
}

/**
 * A hunk's lines with each long run of unchanged ones folded: {@link FOLD_KEEP} lines kept beside a change on either
 * side, and a fold only when it hides at least {@link FOLD_MIN}.
 */
export function foldContext(lines: readonly DiffLine[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  const push = (kind: DiffSegment['kind'], run: readonly DiffLine[]) => {
    const previous = segments.at(-1)
    if (run.length === 0) return
    if (previous?.kind === 'lines' && kind === 'lines') segments[segments.length - 1] = { kind, lines: [...previous.lines, ...run] }
    else segments.push({ kind, lines: run })
  }
  const runs = lines.reduce<DiffLine[][]>((all, line) => {
    const current = all.at(-1)
    if (current !== undefined && (current[0]?.kind === 'context') === (line.kind === 'context')) current.push(line)
    else all.push([line])
    return all
  }, [])
  runs.forEach((run, index) => {
    const unchanged = run[0]?.kind === 'context'
    const head = index === 0 || !unchanged ? 0 : FOLD_KEEP
    const tail = index === runs.length - 1 || !unchanged ? 0 : FOLD_KEEP
    if (!unchanged || run.length - head - tail < FOLD_MIN) {
      push('lines', run)
    } else {
      push('lines', run.slice(0, head))
      push('fold', run.slice(head, run.length - tail))
      push('lines', run.slice(run.length - tail))
    }
  })
  return segments
}

/** The split view's rows: unchanged lines on both sides, and each run of removals beside the additions after it. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  const pending: { del: DiffLine[]; add: DiffLine[] } = { del: [], add: [] }
  const flush = () => {
    const length = Math.max(pending.del.length, pending.add.length)
    rows.push(...Array.from({ length }, (_, at) => ({ left: pending.del[at] ?? null, right: pending.add[at] ?? null })))
    pending.del = []
    pending.add = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      flush()
      rows.push({ left: line, right: line })
      continue
    }
    // A removal after additions starts the next block: the two are not one change.
    if (line.kind === 'del' && pending.add.length > 0) flush()
    pending[line.kind].push(line)
  }
  flush()
  return rows
}
