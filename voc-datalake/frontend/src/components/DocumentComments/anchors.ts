/**
 * @fileoverview Text-quote anchors (W3C `exact` + `prefix` + `suffix`) over a rendered document.
 *
 * The comparison space is the container's text with every whitespace run collapsed to one space,
 * the same space the server matches persona quotes in (lambda/shared/document_series.py
 * `plain_text` + `collapse`). `indexText` walks the text nodes once and keeps, per collapsed
 * character, the node and offset it came from, so a match turns back into a DOM `Range`
 * (highlighted with the CSS Custom Highlight API, never by rewriting the DOM: on the canvas the
 * editor owns it).
 *
 * Two rules make the canvas' DOM index like the rendered Markdown and the server's plain text:
 * a block boundary (paragraph, heading, list item, table cell, line break …) counts as one space
 * even when no whitespace text node sits between the blocks, and an element marked
 * `data-anchor-skip` (the editor's own controls and labels: drag handles, a code block's
 * language, a callout's label) is not part of the text at all.
 *
 * @module components/DocumentComments/anchors
 */
import type { TextQuoteAnchor } from '../../api/documentReviewSchema'

/** How much text around a selection is kept to tell repeated quotes apart. */
const CONTEXT_CHARS = 32
const MAX_EXACT_CHARS = 500
/** = MAX_HEADING_CHARS in lambda/shared/document_comments.py. */
const MAX_HEADING_CHARS = 200
const HEADING_SELECTOR = 'h1, h2, h3, h4'

interface CharSource {
  readonly node: Text
  readonly offset: number
}

export interface TextIndex {
  /** The collapsed text. */
  readonly text: string
  /** Where each character of `text` came from. */
  readonly sources: readonly CharSource[]
}

const isSpace = (char: string) => /\s/.test(char)

/** Elements whose edges separate words: the server's plain text has whitespace there. */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

/** Marks UI chrome inside the document (drag handles, labels): never indexed. */
const SKIP_ATTRIBUTE = 'data-anchor-skip'

/** A text node, or a block edge (a word break with no text of its own). */
type Piece = Text | 'break'

/** The text nodes under `node` in document order, a break at every block's edges, skipped chrome left out. */
function pieces(node: Node): Piece[] {
  if (node instanceof Text) return [node]
  if (!(node instanceof Element)) return [...node.childNodes].flatMap(pieces)
  if (node.hasAttribute(SKIP_ATTRIBUTE)) return []
  const inner = [...node.childNodes].flatMap(pieces)
  return BLOCK_TAGS.has(node.tagName) ? ['break', ...inner, 'break'] : inner
}

/** A piece's characters with their sources (a break stays a break). */
function characters(piece: Piece): (CharSource | 'break')[] {
  return piece === 'break' ? ['break'] : Array.from({ length: piece.data.length }, (_, offset) => ({ node: piece, offset }))
}

/** One pass over the container's text nodes. */
export function indexText(root: Node): TextIndex {
  const chars: string[] = []
  const sources: CharSource[] = []
  // A block edge since the last character: one space, written just before the next visible one.
  const pending = { break: false }
  for (const item of pieces(root).flatMap(characters)) {
    if (item === 'break') {
      pending.break = true
      continue
    }
    const char = item.node.data.charAt(item.offset)
    const space = isSpace(char)
    const afterWord = chars.length > 0 && chars.at(-1) !== ' '
    if (!space && pending.break && afterWord) {
      // The break's space points at the character after it; a quote never starts or ends on a space.
      chars.push(' ')
      sources.push(item)
    }
    if (!space) pending.break = false
    // Collapse a run (also across nodes) and drop leading space.
    if (space && !afterWord) continue
    chars.push(space ? ' ' : char)
    sources.push(item)
  }
  return { text: chars.join(''), sources }
}

/** Collapse every whitespace run to one space, the way `indexText` does. */
function collapseRuns(text: string): string {
  return text.replaceAll(/\s+/g, ' ')
}

/** A quote as matched: runs collapsed and trimmed. */
function collapse(text: string): string {
  return collapseRuns(text).trim()
}

/** How many leading characters `a` and `b` share. */
function commonHead(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  const firstMiss = Array.from({ length: limit }, (_, at) => at).find((at) => a.charAt(at) !== b.charAt(at))
  return firstMiss ?? limit
}

const reversed = (text: string) => Array.from(text).reverse().join('')

/** How many trailing characters `a` and `b` share. */
function commonTail(a: string, b: string): number {
  return commonHead(reversed(a), reversed(b))
}

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/** Every start of `exact` in `text`, overlapping ones included (a lookahead matches without consuming). */
function occurrences(text: string, exact: string): number[] {
  return [...text.matchAll(new RegExp(`(?=${escapeRegExp(exact)})`, 'g'))].map((match) => match.index)
}

/** The start of the best match of `anchor` in `index.text`, or null when the quote is not there. */
function locate(index: TextIndex, anchor: TextQuoteAnchor): number | null {
  const exact = collapse(anchor.exact)
  if (exact === '') return null
  // Context keeps its edge spaces: a word-bounded quote's prefix ends in one, its suffix starts with one.
  const prefix = collapseRuns(anchor.prefix)
  const suffix = collapseRuns(anchor.suffix)
  const score = (start: number) =>
    commonTail(index.text.slice(Math.max(0, start - CONTEXT_CHARS), start), prefix)
    + commonHead(index.text.slice(start + exact.length, start + exact.length + CONTEXT_CHARS), suffix)
  const best = occurrences(index.text, exact).reduce<{ start: number; score: number } | null>((winner, start) => {
    const candidate = { start, score: score(start) }
    return winner === null || candidate.score > winner.score ? candidate : winner
  }, null)
  return best?.start ?? null
}

/** The DOM range of `[start, start + length)` in the collapsed text. */
function rangeOf(index: TextIndex, start: number, length: number): Range | null {
  const first = index.sources[start]
  const last = index.sources[start + length - 1]
  if (first === undefined || last === undefined || length <= 0) return null
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

/** The range an anchor names in `root`, or null when it is not found in this version. */
export function anchorRange(root: Node, anchor: TextQuoteAnchor, index: TextIndex = indexText(root)): Range | null {
  const start = locate(index, anchor)
  return start === null ? null : rangeOf(index, start, collapse(anchor.exact).length)
}

/** The collapsed position of a DOM point (the first indexed character at or after it). */
function positionOf(index: TextIndex, node: Node, offset: number): number {
  const at = index.sources.findIndex((source) => {
    if (source.node === node) return source.offset >= offset
    // A source after the point in document order.
    return (node.compareDocumentPosition(source.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  })
  return at < 0 ? index.text.length : at
}

/** The heading the selection sits under (the last heading before it), or ''. */
function headingBefore(root: Element, range: Range): string {
  const headings = [...root.querySelectorAll(HEADING_SELECTOR)]
  const before = headings.filter((heading) =>
    (heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    || heading.contains(range.startContainer))
  const heading = before.at(-1)
  return heading === undefined ? '' : collapse(indexText(heading).text).slice(0, MAX_HEADING_CHARS)
}

/** The anchor of a selection inside `root`, or null (nothing selected there, or too long). */
export function anchorOfSelection(root: Element, selection: Selection | null): TextQuoteAnchor | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const index = indexText(root)
  const start = positionOf(index, range.startContainer, range.startOffset)
  const end = positionOf(index, range.endContainer, range.endOffset)
  const exact = index.text.slice(start, end).trim()
  if (exact === '' || exact.length > MAX_EXACT_CHARS) return null
  const realStart = index.text.indexOf(exact, start)
  return {
    exact,
    prefix: index.text.slice(Math.max(0, realStart - CONTEXT_CHARS), realStart),
    suffix: index.text.slice(realStart + exact.length, realStart + exact.length + CONTEXT_CHARS),
    heading: headingBefore(root, range),
  }
}
