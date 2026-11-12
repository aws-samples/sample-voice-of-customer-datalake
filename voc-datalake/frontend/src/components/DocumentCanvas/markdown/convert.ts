/**
 * The canvas's Markdown round trip: `markdownToDoc` reads the stored Markdown into the editor's JSON,
 * `docToMarkdown` (of that JSON, or of the editor's live document) writes it back. Given the stored text it came
 * from, every top-level block the user left as it was is written back byte for byte (a one-word edit is a one-line
 * diff in the version history), and an untouched document comes back exactly as stored.
 *
 * Large documents: the editor serialises after each pause in typing, so the work per change follows what changed,
 * not the document's length. The stored text is parsed once (markdownToDoc's parse is kept for its index), each
 * top-level block of the live document is converted once (ProseMirror keeps an untouched block the same object), and
 * the serialiser compares only the blocks an unescape touched (serialize.ts).
 */
import type { JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { BlockContent, RootContent } from 'mdast'
import { blockToDoc, markdownSourceOf } from './fromMdast'
import { containsType, DEFINITION_TYPES, parseMarkdown, serialize, type VerbatimJoins } from './serialize'
import { blockToMdast } from './toMdast'

/**
 * The last text markdownToDoc read and its top-level blocks, so the stored index does not parse it again (the canvas
 * opens a document, then indexes it on the first change); released once indexed.
 */
const parsed: { last: { readonly markdown: string; readonly children: readonly RootContent[] } | null } = { last: null }

export function markdownToDoc(markdown: string): JSONContent {
  const children = parseMarkdown(markdown).children
  parsed.last = { markdown, children }
  const content = children.map((node) => blockToDoc(node, markdown))
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}

interface StoredBlock { readonly key: string; readonly source: string; readonly sensitive: boolean }
interface StoredIndex {
  readonly markdown: string
  readonly blocks: readonly StoredBlock[]
  readonly newlines: readonly number[]
  /** Each key's stored blocks, in order. */
  readonly byKey: ReadonlyMap<string, readonly number[]>
  /** The stored text defines a link or footnote target somewhere (serialize's `definedElsewhere`). */
  readonly defines: boolean
}

/** A block in mdast and its matching key (JSON of the mdast). */
interface Block { readonly mdast: BlockContent; readonly key: string }

const keyOf = (block: BlockContent): string => JSON.stringify(block)

/** A block whose meaning depends on the block before it (a list would merge, indented code would join a list). */
const contextSensitive = (node: RootContent, source: string): boolean =>
  node.type === 'list' || (node.type === 'code' && !/^(?:`{3}|~{3})/.test(source))

function indexStored(markdown: string): StoredIndex {
  const children = parsed.last?.markdown === markdown ? parsed.last.children : parseMarkdown(markdown).children
  // The index keeps what it needs (sources and keys): the parse tree is let go.
  parsed.last = null
  const blocks = children.map((node) => {
    const source = markdownSourceOf(node, markdown)
    const mdast = blockToMdast(blockToDoc(node, markdown))
    return { key: mdast ? keyOf(mdast) : '', source, sensitive: contextSensitive(node, source) }
  })
  const newlines = children.slice(1).map((node, index) => {
    const gap = markdown.slice(children[index]?.position?.end.offset ?? 0, node.position?.start.offset ?? 0)
    return gap.split('\n').length - 1
  })
  const byKey = new Map<string, number[]>()
  blocks.forEach((block, index) => {
    const queue = byKey.get(block.key)
    if (queue) queue.push(index)
    else byKey.set(block.key, [index])
  })
  return { markdown, blocks, newlines, byKey, defines: children.some((node) => containsType(node, DEFINITION_TYPES)) }
}

const cache: { last: StoredIndex | null } = { last: null }

function storedIndex(markdown: string): StoredIndex {
  if (cache.last?.markdown !== markdown) cache.last = indexStored(markdown)
  return cache.last
}

/** Index `markdown` now (when the page is idle after a save), so the next change does not wait for it. */
export function prepareStored(markdown: string): void {
  storedIndex(markdown)
}

/** For each block, the stored block it is unchanged from (in order where it can), or null. */
function matchStored(blocks: readonly Block[], stored: StoredIndex): (number | null)[] {
  /** Each key's stored blocks not matched yet (copied from the index the first time the key comes up). */
  const free = new Map<string, number[]>()
  const freeFor = (key: string): number[] => {
    const known = free.get(key)
    if (known) return known
    const queue = [...(stored.byKey.get(key) ?? [])]
    free.set(key, queue)
    return queue
  }
  const matched: (number | null)[] = []
  /** The stored block the last matched block came from. */
  const last = { index: -1 }
  blocks.forEach(({ key }) => {
    const queue = freeFor(key)
    const at = Math.max(0, queue.findIndex((index) => index > last.index))
    const [index] = queue.splice(at, 1)
    if (index !== undefined) last.index = index
    matched.push(index ?? null)
  })
  return demoteUnsafe(blocks, stored, matched)
}

/**
 * A verbatim block keeps its stored text only where the block before it still reads it the same way: at the top
 * level blocks are a blank line apart, so only a list before a list (they would merge) or before indented code
 * (it would join the list) can change the reading.
 */
function demoteUnsafe(blocks: readonly Block[], stored: StoredIndex, matched: (number | null)[]): (number | null)[] {
  const at = matched.findIndex((index, position) => index !== null && unsafeVerbatim(blocks, stored, matched, position, index))
  if (at === -1) return matched
  matched[at] = null
  return demoteUnsafe(blocks, stored, matched)
}

function unsafeVerbatim(blocks: readonly Block[], stored: StoredIndex, matched: readonly (number | null)[], at: number, index: number): boolean {
  const newListBefore = blocks[at - 1]?.mdast.type === 'list' && matched[at - 1] !== index - 1
  if (stored.blocks[index]?.sensitive === true && newListBefore) return true
  // A rewritten list right after it would take the same bullet and merge with it.
  return blocks[at]?.mdast.type === 'list' && blocks[at + 1]?.mdast.type === 'list' && matched[at + 1] === null
}

function verbatimTree(blocks: readonly Block[], stored: StoredIndex, matched: readonly (number | null)[]) {
  const joins: VerbatimJoins = new WeakMap()
  const blankLines = (index: number) => (next: number) =>
    next === index + 1 ? Math.max(0, (stored.newlines[index] ?? 2) - 1) : null
  const children = blocks.map(({ mdast }, at): BlockContent => {
    const index = matched[at] ?? null
    const source = index === null ? undefined : stored.blocks[index]?.source
    if (index === null || source === undefined) return mdast
    const node: BlockContent = { type: 'verbatim', value: source }
    joins.set(node, { index, blankLines: blankLines(index) })
    return node
  })
  return { tree: { type: 'root' as const, children }, joins }
}

function blocksToMarkdown(blocks: readonly Block[], stored?: string): string {
  if (stored === undefined) return serialize({ type: 'root', children: blocks.map(({ mdast }) => mdast) }, null, false)
  const index = storedIndex(stored)
  const matched = matchStored(blocks, index)
  if (matched.length === index.blocks.length && matched.every((at, position) => at === position)) return stored
  const { tree, joins } = verbatimTree(blocks, index, matched)
  return withEndOf(serialize(tree, joins, index.defines), stored)
}

function toBlock(node: JSONContent): Block | null {
  const mdast = blockToMdast(node)
  return mdast ? { mdast, key: keyOf(mdast) } : null
}

/** ProseMirror types its JSON as any: a node's JSON is an object with its type's name. */
const isContent = (json: unknown): json is JSONContent =>
  typeof json === 'object' && json !== null && 'type' in json && typeof json.type === 'string'

/** Each live top-level block's conversion: ProseMirror nodes never change, an edited block is a new node. */
const converted = new WeakMap<PMNode, Block | null>()

function convertedBlock(node: PMNode): Block | null {
  const known = converted.get(node)
  if (known !== undefined) return known
  const json: unknown = node.toJSON()
  // Never dropped quietly: a block the serialiser cannot read stops the save instead.
  if (!isContent(json)) throw new Error(`docToMarkdown: a ${node.type.name} block without its JSON`)
  const block = toBlock(json)
  converted.set(node, block)
  return block
}

/** A ProseMirror node's type is its NodeType; in the JSON it is the type's name. */
const isLive = (doc: JSONContent | PMNode): doc is PMNode => typeof doc.type === 'object'

function liveBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = []
  doc.forEach((child) => {
    const block = convertedBlock(child)
    if (block) blocks.push(block)
  })
  return blocks
}

/**
 * The document as Markdown: the editor's JSON, or its live document (`editor.state.doc`), whose untouched blocks
 * are converted once and remembered (the editor's path after each change).
 */
export function docToMarkdown(doc: JSONContent | PMNode, stored?: string): string {
  if (isLive(doc)) return blocksToMarkdown(liveBlocks(doc), stored)
  return blocksToMarkdown((doc.content ?? []).flatMap((node) => toBlock(node) ?? []), stored)
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
