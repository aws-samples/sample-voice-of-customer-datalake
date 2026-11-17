/** The editor's ProseMirror JSON -> mdast: the exact inverse of fromMdast.ts. */
import type { JSONContent } from '@tiptap/core'
import type { AlignType, BlockContent, List, ListItem, Paragraph, PhrasingContent, Table, TableCell } from 'mdast'
import './mdastTypes'
import { attrArray, attrBoolean, attrNumber, attrString } from './attrs'
import { alertMarker, isCalloutKind } from './callout'
import { inlineToMdast } from './inlineToMdast'

/** A ProseMirror node's children (none for a leaf). */
const pmChildren = (node: JSONContent): readonly JSONContent[] => node.content ?? []
const phrasing = (node: JSONContent): PhrasingContent[] => inlineToMdast(pmChildren(node))

/** A container's blocks; the lone empty paragraph ProseMirror needs in an empty container is no block at all. */
function blocksToMdast(nodes: readonly JSONContent[]): BlockContent[] {
  return nodes.flatMap((node) => {
    const block = blockToMdast(node)
    return block ? [block] : []
  })
}

function listItemToMdast(item: JSONContent, task: boolean): ListItem {
  const checked = task ? attrBoolean(item.attrs, 'checked') === true : attrBoolean(item.attrs, 'checked')
  return {
    type: 'listItem',
    spread: attrBoolean(item.attrs, 'spread') ?? false,
    checked,
    children: blocksToMdast(pmChildren(item)),
  }
}

function listToMdast(node: JSONContent): List {
  const task = node.type === 'taskList'
  const ordered = node.type === 'orderedList' || (task && attrBoolean(node.attrs, 'ordered') === true)
  return {
    type: 'list',
    ordered,
    start: ordered ? attrNumber(node.attrs, 'start') ?? 1 : null,
    spread: attrBoolean(node.attrs, 'spread') ?? false,
    children: pmChildren(node).map((item) => listItemToMdast(item, task)),
  }
}

function calloutToMdast(node: JSONContent): BlockContent {
  const kindAttr = attrString(node.attrs, 'kind')
  const kind = isCalloutKind(kindAttr) ? kindAttr : 'note'
  const marker = alertMarker(kind)
  const blocks = blocksToMdast(pmChildren(node))
  const [first, ...rest] = blocks
  if (attrBoolean(node.attrs, 'split') === true || first?.type !== 'paragraph') {
    return { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: marker }] }, ...blocks] }
  }
  return { type: 'blockquote', children: [withLeadingText(first, `${marker}\n`), ...rest] }
}

function withLeadingText(paragraph: Paragraph, lead: string): Paragraph {
  const [head, ...tail] = paragraph.children
  if (head?.type === 'text') return { ...paragraph, children: [{ type: 'text', value: lead + head.value }, ...tail] }
  return { ...paragraph, children: [{ type: 'text', value: lead }, ...paragraph.children] }
}

function cellToMdast(cell: JSONContent): TableCell {
  const inline = pmChildren(cell).flatMap((paragraph, index) =>
    index === 0 ? pmChildren(paragraph) : [{ type: 'text', text: ' ' }, ...pmChildren(paragraph)])
  return { type: 'tableCell', children: inlineToMdast(inline) }
}

function alignOf(value: unknown): AlignType {
  return value === 'left' || value === 'right' || value === 'center' ? value : null
}

function tableToMdast(node: JSONContent): Table {
  const align = attrArray(node.attrs, 'align')
  return {
    type: 'table',
    ...(align ? { align: align.map(alignOf) } : {}),
    children: pmChildren(node).map((row) => ({ type: 'tableRow', children: pmChildren(row).map(cellToMdast) })),
  }
}

function codeText(node: JSONContent): string {
  return pmChildren(node).map((child) => child.text ?? '').join('')
}

const DEPTHS = [1, 2, 3, 4, 5, 6] as const

function headingDepth(node: JSONContent): (typeof DEPTHS)[number] {
  const level = attrNumber(node.attrs, 'level') ?? 1
  return DEPTHS.find((depth) => depth >= level) ?? 6
}

function paragraphToMdast(node: JSONContent): BlockContent | null {
  const children = phrasing(node)
  return children.length === 0 ? null : { type: 'paragraph', children }
}

const BLOCKS: Record<string, (node: JSONContent) => BlockContent | null> = {
  paragraph: paragraphToMdast,
  heading: (node) => ({ type: 'heading', depth: headingDepth(node), children: phrasing(node) }),
  horizontalRule: () => ({ type: 'thematicBreak' }),
  blockquote: (node) => ({ type: 'blockquote', children: blocksToMdast(pmChildren(node)) }),
  callout: calloutToMdast,
  bulletList: listToMdast,
  orderedList: listToMdast,
  taskList: listToMdast,
  codeBlock: (node) => ({ type: 'code', lang: attrString(node.attrs, 'language'), meta: attrString(node.attrs, 'meta'), value: codeText(node) }),
  table: tableToMdast,
  rawBlock: (node) => ({ type: 'rawBlock', value: attrString(node.attrs, 'source') ?? '' }),
}

export function blockToMdast(node: JSONContent): BlockContent | null {
  const convert = node.type === undefined ? undefined : BLOCKS[node.type]
  return convert ? convert(node) : null
}
