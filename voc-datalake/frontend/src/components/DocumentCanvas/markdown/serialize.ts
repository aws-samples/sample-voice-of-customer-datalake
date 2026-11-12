/**
 * mdast -> Markdown text, in the dialect the stored documents are written in (ATX headings, `-` bullets, `**`
 * strong, `*` emphasis, fenced code, `---` rules). Text is escaped as little as the reading allows: the
 * serialiser's cautious escapes (`\[FR:fr_1]`, `a \* b`) are dropped whenever the result reads back as the same
 * tree, so citations and plain prose stay the way people wrote them.
 */
import type { Blockquote, Parents, PhrasingContent, Root, RootContent, Text } from 'mdast'
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

/** Positions aside, the tree a Markdown text reads as. */
export function readTree(markdown: string): string {
  return JSON.stringify(parseMarkdown(markdown), (key, value: unknown) => (key === 'position' ? undefined : value))
}

export function serialize(tree: Root, joins: VerbatimJoins | null = null): string {
  const cautious = toMarkdown(tree, options(null, joins))
  const boldest = toMarkdown(tree, options(UNESCAPES[0], joins))
  // The boldest unescape changed nothing: no escape can be dropped.
  if (boldest === cautious) return cautious
  const expected = readTree(cautious)
  if (readTree(boldest) === expected) return boldest
  const brackets = toMarkdown(tree, options(UNESCAPES[1], joins))
  return brackets !== cautious && readTree(brackets) === expected ? brackets : cautious
}
