/**
 * The canvas's Markdown round trip: `markdownToDoc` reads the stored Markdown into the editor's JSON,
 * `docToMarkdown` writes it back. Given the stored text it came from, every top-level block the user left as it
 * was is written back byte for byte (a one-word edit is a one-line diff in the version history), and an
 * untouched document comes back exactly as stored.
 */
import type { JSONContent } from '@tiptap/core'
import type { BlockContent, RootContent } from 'mdast'
import { blockToDoc, markdownSourceOf } from './fromMdast'
import { parseMarkdown, serialize, type VerbatimJoins } from './serialize'
import { blockToMdast } from './toMdast'

export function markdownToDoc(markdown: string): JSONContent {
  const content = parseMarkdown(markdown).children.map((node) => blockToDoc(node, markdown))
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}

interface StoredBlock { readonly key: string; readonly source: string; readonly sensitive: boolean }
interface StoredIndex { readonly markdown: string; readonly blocks: readonly StoredBlock[]; readonly newlines: readonly number[] }

const keyOf = (block: BlockContent): string => JSON.stringify(block)

/** A block whose meaning depends on the block before it (a list would merge, indented code would join a list). */
const contextSensitive = (node: RootContent, source: string): boolean =>
  node.type === 'list' || (node.type === 'code' && !/^(?:`{3}|~{3})/.test(source))

function indexStored(markdown: string): StoredIndex {
  const children = parseMarkdown(markdown).children
  const blocks = children.map((node) => {
    const source = markdownSourceOf(node, markdown)
    const mdast = blockToMdast(blockToDoc(node, markdown))
    return { key: mdast ? keyOf(mdast) : '', source, sensitive: contextSensitive(node, source) }
  })
  const newlines = children.slice(1).map((node, index) => {
    const gap = markdown.slice(children[index]?.position?.end.offset ?? 0, node.position?.start.offset ?? 0)
    return gap.split('\n').length - 1
  })
  return { markdown, blocks, newlines }
}

const cache: { last: StoredIndex | null } = { last: null }

function storedIndex(markdown: string): StoredIndex {
  if (cache.last?.markdown !== markdown) cache.last = indexStored(markdown)
  return cache.last
}

/** For each block, the stored block it is unchanged from (in order where it can), or null. */
function matchStored(blocks: readonly BlockContent[], stored: StoredIndex): (number | null)[] {
  const free = new Map<string, number[]>()
  stored.blocks.forEach((block, index) => free.set(block.key, [...(free.get(block.key) ?? []), index]))
  const matched: (number | null)[] = []
  blocks.forEach((block) => {
    const queue = free.get(keyOf(block)) ?? []
    const previous = matched.reduce<number>((last, index) => index ?? last, -1)
    const at = Math.max(0, queue.findIndex((index) => index > previous))
    const [index] = queue.splice(at, 1)
    matched.push(index ?? null)
  })
  return demoteUnsafe(blocks, stored, matched)
}

/**
 * A verbatim block keeps its stored text only where the block before it still reads it the same way: at the top
 * level blocks are a blank line apart, so only a list before a list (they would merge) or before indented code
 * (it would join the list) can change the reading.
 */
function demoteUnsafe(blocks: readonly BlockContent[], stored: StoredIndex, matched: (number | null)[]): (number | null)[] {
  const at = matched.findIndex((index, position) => index !== null && unsafeVerbatim(blocks, stored, matched, position, index))
  if (at === -1) return matched
  matched[at] = null
  return demoteUnsafe(blocks, stored, matched)
}

function unsafeVerbatim(blocks: readonly BlockContent[], stored: StoredIndex, matched: readonly (number | null)[], at: number, index: number): boolean {
  const newListBefore = blocks[at - 1]?.type === 'list' && matched[at - 1] !== index - 1
  if (stored.blocks[index]?.sensitive === true && newListBefore) return true
  // A rewritten list right after it would take the same bullet and merge with it.
  return blocks[at]?.type === 'list' && blocks[at + 1]?.type === 'list' && matched[at + 1] === null
}

function verbatimTree(blocks: readonly BlockContent[], stored: StoredIndex, matched: readonly (number | null)[]) {
  const joins: VerbatimJoins = new WeakMap()
  const blankLines = (index: number) => (next: number) =>
    next === index + 1 ? Math.max(0, (stored.newlines[index] ?? 2) - 1) : null
  const children = blocks.map((block, at): BlockContent => {
    const index = matched[at] ?? null
    const source = index === null ? undefined : stored.blocks[index]?.source
    if (index === null || source === undefined) return block
    const node: BlockContent = { type: 'verbatim', value: source }
    joins.set(node, { index, blankLines: blankLines(index) })
    return node
  })
  return { tree: { type: 'root' as const, children }, joins }
}

export function docToMarkdown(doc: JSONContent, stored?: string): string {
  const blocks = (doc.content ?? []).flatMap((node) => {
    const block = blockToMdast(node)
    return block ? [block] : []
  })
  if (stored === undefined) return serialize({ type: 'root', children: blocks })
  const index = storedIndex(stored)
  const matched = matchStored(blocks, index)
  if (matched.length === index.blocks.length && matched.every((at, position) => at === position)) return stored
  const { tree, joins } = verbatimTree(blocks, index, matched)
  return withEndOf(serialize(tree, joins), stored)
}

/**
 * The serialiser ends with a newline; the saved text ends the way the stored one did, so an edit is not also a
 * change to the last line. Stored documents (generated, created in the modal, saved by the API) end without one, and
 * so does a blank document.
 */
function withEndOf(markdown: string, stored: string): string {
  const body = markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown
  return stored.endsWith('\n') && body !== '' ? `${body}\n` : body
}
