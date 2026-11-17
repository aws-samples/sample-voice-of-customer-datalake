/**
 * mdast -> Markdown text, in the dialect the stored documents are written in (ATX headings, `-` bullets, `**`
 * strong, `*` emphasis, fenced code, `---` rules). Text is escaped as little as the reading allows: the
 * serialiser's cautious escapes (`\[FR:fr_1]`, `a \* b`) are dropped whenever the result reads back as the same
 * tree, so citations and plain prose stay the way people wrote them.
 */
import type { Blockquote, Nodes, Parents, PhrasingContent, Root, RootContent, Text } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { defaultHandlers, type Info, type Join, type Options, type State, toMarkdown } from 'mdast-util-to-markdown'
import { gfm } from 'micromark-extension-gfm'
import './mdastTypes'
import { alertMarker, calloutKindOf } from './callout'

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/** The separators between two blocks that were next to each other in the stored text (`\n` count - 1). */
export type VerbatimJoins = WeakMap<RootContent, { readonly index: number; readonly blankLines: (next: number) => number | null }>

const literal = (node: { readonly value: string }): string => node.value

/** A GFM alert's `[!NOTE]` is written as it is, never escaped to `\[!NOTE]`. */
function blockquote(node: Blockquote, parent: Parents | undefined, state: State, info: Info): string {
  const kind = calloutKindOf(node)
  const [first, ...rest] = node.children
  if (!kind || first?.type !== 'paragraph') return defaultHandlers.blockquote(node, parent, state, info)
  const [lead, ...inline] = first.children
  const marker = alertMarker(kind)
  const after = lead?.type === 'text' ? lead.value.slice(marker.length) : ''
  const children: PhrasingContent[] = [{ type: 'rawInline', value: marker }, ...(after === '' ? [] : [{ type: 'text' as const, value: after }]), ...inline]
  return defaultHandlers.blockquote({ ...node, children: [{ ...first, children }, ...rest] }, parent, state, info)
}

type Unescape = (escaped: string) => string

const unescapeOnly = (characters: string): Unescape => (escaped) =>
  escaped.replace(/\\([\s\S])/g, (whole, character: string) => (characters.includes(character) ? character : whole))

function options(unescape: Unescape | null, joins: VerbatimJoins | null): Options {
  const join: Join = (left, right) => {
    const fromLeft = joins?.get(left)
    const toRight = joins?.get(right)
    return fromLeft && toRight ? fromLeft.blankLines(toRight.index) ?? undefined : undefined
  }
  return {
    extensions: [gfmToMarkdown({ tablePipeAlign: false })],
    bullet: '-',
    bulletOther: '*',
    bulletOrdered: '.',
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    rule: '-',
    listItemIndent: 'one',
    incrementListMarker: true,
    resourceLink: false,
    join: [join],
    handlers: {
      rawBlock: literal,
      rawInline: literal,
      verbatim: literal,
      blockquote,
      ...(unescape ? { text: (node: Text, _parent: Parents | undefined, state: State, info: Info) => unescape(state.safe(node.value, info)) } : {}),
    },
  }
}

const UNESCAPES = [unescapeOnly('[]_*'), unescapeOnly('[]')] as const

const stripPositions = (tree: Root): string => JSON.stringify(tree, (key, value: unknown) => (key === 'position' ? undefined : value))

/** Positions aside, the tree a Markdown text reads as. */
export function readTree(markdown: string): string {
  return stripPositions(parseMarkdown(markdown))
}

/** A serialisation and the text of each top-level block in it (the separators between them are not blocks). */
interface Rendering { readonly text: string; readonly blocks: readonly string[] }

function render(tree: Root, unescape: Unescape | null, joins: VerbatimJoins | null): Rendering {
  const blocks: string[] = []
  const base = options(unescape, joins)
  const root = (node: Root, parent: Parents | undefined, state: State, info: Info): string => {
    const handle = state.handle
    // containerFlow writes each child through state.handle: note the text of each child of this root. Handlers
    // read the state as `this`, and the phrasing writer reads `state.handle.handlers`: both stay as they were.
    const noting: State['handle'] = (child, childParent, childState, childInfo) => {
      const text = handle.call(state, child, childParent, childState, childInfo)
      if (childParent === node) blocks.push(text)
      return text
    }
    state.handle = Object.assign(noting, handle)
    try {
      return defaultHandlers.root(node, parent, state, info)
    } finally {
      state.handle = handle
    }
  }
  return { text: toMarkdown(tree, { ...base, handlers: { ...base.handlers, root } }), blocks }
}

const RAW_TYPES: ReadonlySet<string> = new Set(['rawBlock', 'rawInline'])

/** True when a node or any node inside it is one of `types`. */
export function containsType(node: Nodes, types: ReadonlySet<string>): boolean {
  if (types.has(node.type)) return true
  return 'children' in node && node.children.some((child: Nodes) => containsType(child, types))
}

/** The node types that make a reading depend on text elsewhere in the document (a reference finds its definition). */
export const DEFINITION_TYPES: ReadonlySet<string> = new Set(['definition', 'footnoteDefinition'])

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/
/** CommonMark's HTML blocks 1-5, which end only at their own end marker (6 and 7 end at a blank line). */
const OPENING_HTML = /^ {0,3}<(?:(script|pre|style|textarea)(?=[\s>]|$)|(!--)|(\?)|(!\[CDATA\[)|(![a-z]))/i

/**
 * Whether an HTML block that opened with `match` holds the end marker the Markdown parser (micromark, CommonMark's
 * end conditions) closes it at. These are the parser's markers, not a browser's: a browser also ends a comment at
 * `--!>`, but the parser does not, so a comment ended only by `--!>` still swallows what follows and counts as open.
 * A comment's `-->` and an instruction's `?>` may share characters with the opener (`<!-->`, `<!--->` and `<?>` are
 * closed), so their search starts inside it; the others start after it.
 */
function holdsHtmlEnd(source: string, match: RegExpExecArray): boolean {
  const [opener, tag, comment, instruction, cdata] = match
  const after = opener.length
  if (tag !== undefined) return source.slice(after).toLowerCase().includes(`</${tag.toLowerCase()}>`)
  if (comment !== undefined) return source.includes('-->', after - 2)
  if (instruction !== undefined) return source.includes('?>', after - 1)
  return source.includes(cdata === undefined ? '>' : ']]>', after)
}

/**
 * A stored block that runs on past the blank line after it, so it swallows every block written after it: a fenced
 * code block without its closing fence, or an HTML block (`<!--`, `<pre>`, `<script>`, `<?`, `<![CDATA[`, `<!X`)
 * without its end marker. Each block's stored source is its own text: a closed one ends with its closing fence or
 * holds its end marker.
 */
export function mayStayOpen(source: string): boolean {
  const fence = OPENING_FENCE.exec(source)?.[1]
  if (fence !== undefined) {
    const lines = source.split('\n')
    const closing = new RegExp(`^ {0,3}${fence.startsWith('`') ? '`' : '~'}{${String(fence.length)},}[ \\t]*$`)
    return lines.length < 2 || !closing.test(lines.at(-1) ?? '')
  }
  const html = OPENING_HTML.exec(source)
  return html !== null && !holdsHtmlEnd(source, html)
}

/**
 * Whether two serialisations of one tree read as the same tree. They differ only inside the blocks the unescape
 * touched; every block is a blank line (or a `<!---->` comment) from the next, so each block reads the same alone as in
 * the document, except where a reference meets a definition elsewhere in the text or a block before it never closes.
 * Without either (no definition in the blocks written as stored, `definedElsewhere` false, none in the editor's raw
 * Markdown, none in either reading of a touched block, and no stored fence or HTML block) comparing the touched blocks
 * alone gives the answer comparing the whole text does, at the cost of the touched blocks instead of the whole
 * document; otherwise the whole text is compared.
 */
function readsTheSame(tree: Root, a: Rendering, b: Rendering, definedElsewhere: boolean): boolean {
  const touched = a.blocks.flatMap((block, index) => (block === b.blocks[index] ? [] : [index]))
  const local = !definedElsewhere && a.blocks.length === tree.children.length && b.blocks.length === tree.children.length &&
    !tree.children.some((child) => (child.type === 'verbatim' ? mayStayOpen(child.value) : containsType(child, RAW_TYPES)))
  if (!local) return readTree(a.text) === readTree(b.text)
  return touched.every((index) => {
    const [left, right] = [parseMarkdown(a.blocks[index] ?? ''), parseMarkdown(b.blocks[index] ?? '')]
    if (containsType(left, DEFINITION_TYPES) || containsType(right, DEFINITION_TYPES)) return readTree(a.text) === readTree(b.text)
    return stripPositions(left) === stripPositions(right)
  })
}

/**
 * `definedElsewhere`: the caller cannot rule out a definition (`[id]: url`, `[^id]: note`) in the blocks it passes as
 * `verbatim`, so every reading compares the whole text (the default). False only where the caller knows (convert.ts:
 * the stored text's own parse, or no stored blocks at all).
 */
export function serialize(tree: Root, joins: VerbatimJoins | null = null, definedElsewhere = true): string {
  const cautious = render(tree, null, joins)
  const boldest = render(tree, UNESCAPES[0], joins)
  // The boldest unescape changed nothing: no escape can be dropped.
  if (boldest.text === cautious.text) return cautious.text
  if (readsTheSame(tree, cautious, boldest, definedElsewhere)) return boldest.text
  const brackets = render(tree, UNESCAPES[1], joins)
  return brackets.text !== cautious.text && readsTheSame(tree, cautious, brackets, definedElsewhere) ? brackets.text : cautious.text
}
