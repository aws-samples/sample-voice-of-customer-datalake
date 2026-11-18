/**
 * @fileoverview The light reader's one pass over the Markdown tree (a remark plugin for react-markdown), so a text
 * reads as it does on the canvas (components/Document/edit/markdown/fromMdast.ts) without loading the editor:
 * - what the canvas has no node for (raw HTML, footnotes, reference links and definitions) shows as its source, as
 *   the canvas's raw atoms do (`pre.canvas-raw`, `code.canvas-raw-inline`). Raw HTML is never rendered
 *   as HTML.
 * - a GFM alert (`> [!NOTE]` …) is the canvas's callout: `div[data-callout]` with its kind's name, the marker gone;
 * - every heading carries the canvas's id (components/Document/headingSlug.ts), and the h1–h3 are reported as the
 *   Contents, read in the same pass (no second parse).
 *
 * @module components/Document/read/remarkParity
 */
import { calloutKindOf, ALERT_MARKER } from '../edit/markdown/callout'
import { markdownSourceOf } from '../edit/markdown/fromMdast'
import { headingId } from '../headingSlug'
import type { BlockContent, Blockquote, DefinitionContent, Heading, Paragraph, PhrasingContent, Root, RootContent } from 'mdast'
import type { CalloutKind } from '../edit/markdown/callout'
import type { OutlineItem } from '../types'

export interface ParityOptions {
  /** A callout's accessible name per kind, already translated. */
  readonly calloutLabels: Readonly<Record<CalloutKind, string>>
  /** Put the ids on the rendered headings (off: the outline still names them). */
  readonly ids: boolean
  /** The h1–h3 of the text, in order, with their ids: called once per parse. */
  readonly onHeadings?: (items: readonly OutlineItem[]) => void
}

/** The source of a node the canvas keeps as a raw block: a `pre.canvas-raw` holding it, never parsed again. */
function rawBlock(source: string): Paragraph {
  return {
    type: 'paragraph', children: [],
    data: {
      hName: 'pre', hProperties: { className: ['canvas-raw'], translate: 'no' },
      hChildren: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: source }] }],
    },
  }
}

function rawInline(source: string): PhrasingContent {
  return { type: 'inlineCode', value: source, data: { hProperties: { className: ['canvas-raw-inline'], translate: 'no' } } }
}

/** A heading's text as the canvas's `textContent` reads it: its text and inline code, never raw source. */
function headingText(nodes: readonly PhrasingContent[]): string {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'inlineCode') return node.value
    return 'children' in node ? headingText(node.children) : ''
  }).join('')
}

interface Pass {
  readonly source: string
  readonly options: ParityOptions
  readonly seen: Map<string, number>
  readonly outline: OutlineItem[]
}

/** The canvas's inline rule (fromMdast `inlinesToDoc`): anything it has no mark or node for is raw. */
function inline(nodes: readonly PhrasingContent[], pass: Pass): PhrasingContent[] {
  return nodes.flatMap((node): PhrasingContent[] => {
    switch (node.type) {
      case 'text': case 'break': case 'image': return [node]
      case 'inlineCode': return node.value === '' ? [rawInline(markdownSourceOf(node, pass.source))] : [node]
      case 'emphasis': case 'strong': case 'delete': return [{ ...node, children: inline(node.children, pass) }]
      // An empty link (`[](url)`) has no text to carry it: the canvas keeps it as source.
      case 'link': return node.children.length === 0
        ? [rawInline(markdownSourceOf(node, pass.source))]
        : [{ ...node, children: inline(node.children, pass) }]
      case 'html': return [rawInline(node.value)]
      default: return [rawInline(markdownSourceOf(node, pass.source))]
    }
  })
}

/** The Contents' levels: h1–h3. */
const OUTLINE_LEVELS: Readonly<Partial<Record<number, OutlineItem['level']>>> = { 1: 1, 2: 2, 3: 3 }

function heading(node: Heading, pass: Pass): Heading {
  const children = inline(node.children, pass)
  const text = headingText(node.children)
  const id = headingId(pass.seen, text)
  const level = OUTLINE_LEVELS[node.depth]
  if (level !== undefined) pass.outline.push({ id, level, text })
  if (!pass.options.ids) return { ...node, children }
  return { ...node, children, data: { ...node.data, hProperties: { ...node.data?.hProperties, id } } }
}

/** The canvas's callout (fromMdast `calloutToDoc`): the marker taken off the first line, its kind on the box. */
function callout(quote: Blockquote, kind: CalloutKind, pass: Pass): Blockquote {
  const [first, ...rest] = quote.children
  const [lead, ...after] = first?.type === 'paragraph' ? first.children : []
  const remainder = lead?.type === 'text' ? lead.value.replace(ALERT_MARKER, '') : ''
  const opening: PhrasingContent[] = remainder === '' ? after : [{ type: 'text', value: remainder }, ...after]
  const children = opening.length === 0 ? rest : [{ type: 'paragraph' as const, children: opening }, ...rest]
  return {
    ...quote,
    children: blocks(children, pass),
    data: { hName: 'div', hProperties: { dataCallout: kind, role: 'note', ariaLabel: pass.options.calloutLabels[kind] } },
  }
}

/** A block of a container (the root, a quote, a list item). */
type Block = BlockContent | DefinitionContent

function block(node: RootContent, pass: Pass): Block[] {
  switch (node.type) {
    case 'paragraph': return [{ ...node, children: inline(node.children, pass) }]
    case 'heading': return [heading(node, pass)]
    case 'thematicBreak': case 'code': return [node]
    case 'blockquote': {
      const kind = calloutKindOf(node)
      return [kind === null ? { ...node, children: blocks(node.children, pass) } : callout(node, kind, pass)]
    }
    case 'list': return [{ ...node, children: node.children.map((item) => ({ ...item, children: blocks(item.children, pass) })) }]
    case 'table': return [{
      ...node,
      children: node.children.map((row) => ({ ...row, children: row.children.map((cell) => ({ ...cell, children: inline(cell.children, pass) })) })),
    }]
    case 'html': return [rawBlock(node.value)]
    default: return [rawBlock(markdownSourceOf(node, pass.source))]
  }
}

function blocks(nodes: readonly RootContent[], pass: Pass): Block[] {
  return nodes.flatMap((node) => block(node, pass))
}

/** The plugin (react-markdown's `remarkPlugins`, after remark-gfm). */
export function remarkParity(options: ParityOptions) {
  return (tree: Root, file: { readonly value: unknown }): void => {
    const pass: Pass = { source: String(file.value), options, seen: new Map(), outline: [] }
    tree.children = blocks(tree.children, pass)
    options.onHeadings?.(pass.outline)
  }
}
