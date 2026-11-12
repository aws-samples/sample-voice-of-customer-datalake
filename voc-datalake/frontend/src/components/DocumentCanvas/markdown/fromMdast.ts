/** mdast (micromark + GFM) -> the editor's ProseMirror JSON. Anything without a node becomes a raw-Markdown atom. */
import type { JSONContent } from '@tiptap/core'
import type { Blockquote, Code, List, ListItem, Nodes, PhrasingContent, RootContent, Table } from 'mdast'
import { ALERT_MARKER, type CalloutKind, calloutKindOf } from './callout'

type Mark = NonNullable<JSONContent['marks']>[number]

const emptyParagraph = (): JSONContent => ({ type: 'paragraph' })

/** The node's exact source, with the container prefixes (`> `, list indentation) of its later lines removed. */
export function markdownSourceOf(node: Nodes, source: string): string {
  const start = node.position?.start
  const end = node.position?.end
  if (start?.offset === undefined || end?.offset === undefined) return ''
  const slice = source.slice(start.offset, end.offset)
  const indent = start.column - 1
  if (indent === 0) return slice
  return slice.split('\n').map((line, index) => (index === 0 ? line : dedent(line, indent))).join('\n')
}

function dedent(line: string, width: number): string {
  const prefix = line.slice(0, width)
  const cut = prefix.length - prefix.replace(/^[ \t>]*/, '').length
  return line.slice(cut)
}

function rawInline(node: Nodes, source: string, marks: readonly Mark[]): JSONContent {
  return withMarks({ type: 'rawInline', attrs: { source: node.type === 'html' ? node.value : markdownSourceOf(node, source) } }, marks)
}

function withMarks(node: JSONContent, marks: readonly Mark[]): JSONContent {
  return marks.length > 0 ? { ...node, marks: [...marks] } : node
}

function markOf(node: PhrasingContent): Mark | null {
  switch (node.type) {
    case 'emphasis': return { type: 'italic' }
    case 'strong': return { type: 'bold' }
    case 'delete': return { type: 'strike' }
    case 'link': return { type: 'link', attrs: { href: node.url, title: node.title ?? null } }
    default: return null
  }
}

function inlineLeaf(node: PhrasingContent, source: string, marks: readonly Mark[]): JSONContent[] {
  switch (node.type) {
    case 'text': return node.value === '' ? [] : [withMarks({ type: 'text', text: node.value }, marks)]
    case 'inlineCode':
      return node.value === '' ? [rawInline(node, source, marks)]
        : [{ type: 'text', text: node.value, marks: [...marks, { type: 'code' }] }]
    case 'break': return [withMarks({ type: 'hardBreak' }, marks)]
    case 'image':
      return [withMarks({ type: 'image', attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null } }, marks)]
    default: return [rawInline(node, source, marks)]
  }
}

function inlinesToDoc(nodes: readonly PhrasingContent[], source: string, marks: readonly Mark[] = []): JSONContent[] {
  return nodes.flatMap((node) => {
    const mark = markOf(node)
    // An empty link (`[](url)`) has no text to carry the mark: keep it as raw source.
    if (mark && 'children' in node && node.children.length > 0) return inlinesToDoc(node.children, source, [...marks, mark])
    if (mark) return [rawInline(node, source, marks)]
    return inlineLeaf(node, source, marks)
  })
}

function textblock(type: string, children: readonly PhrasingContent[], source: string, attrs?: JSONContent['attrs']): JSONContent {
  const content = inlinesToDoc(children, source)
  return { type, ...(attrs ? { attrs } : {}), ...(content.length > 0 ? { content } : {}) }
}

/** A container's blocks; a container mdast leaves empty gets the one empty paragraph ProseMirror needs. */
function blocksToDoc(nodes: readonly RootContent[], source: string): JSONContent[] {
  return nodes.length === 0 ? [emptyParagraph()] : nodes.map((node) => blockToDoc(node, source))
}

const taskItemToDoc = (item: ListItem, source: string): JSONContent =>
  ({ type: 'taskItem', attrs: { checked: item.checked === true, spread: item.spread ?? false }, content: blocksToDoc(item.children, source) })

const listItemToDoc = (item: ListItem, source: string): JSONContent =>
  ({ type: 'listItem', attrs: { checked: item.checked ?? null, spread: item.spread ?? false }, content: blocksToDoc(item.children, source) })

function listToDoc(list: List, source: string): JSONContent {
  const task = list.children.length > 0 && list.children.every((item) => typeof item.checked === 'boolean')
  const ordered = list.ordered === true
  const content = list.children.map((item) => (task ? taskItemToDoc(item, source) : listItemToDoc(item, source)))
  const spread = list.spread ?? false
  if (task) return { type: 'taskList', attrs: { ordered, start: list.start ?? null, spread }, content }
  if (ordered) return { type: 'orderedList', attrs: { start: list.start ?? 1, spread }, content }
  return { type: 'bulletList', attrs: { spread }, content }
}

function calloutToDoc(quote: Blockquote, kind: CalloutKind, source: string): JSONContent {
  const [first, ...rest] = quote.children
  if (first?.type !== 'paragraph') return { type: 'blockquote', content: blocksToDoc(quote.children, source) }
  const [lead, ...inline] = first.children
  const remainder = lead?.type === 'text' ? lead.value.replace(ALERT_MARKER, '') : ''
  const children: PhrasingContent[] = remainder === '' ? inline : [{ type: 'text', value: remainder }, ...inline]
  const split = children.length === 0
  const blocks: RootContent[] = split ? rest : [{ type: 'paragraph', children }, ...rest]
  return { type: 'callout', attrs: { kind, split }, content: blocksToDoc(blocks, source) }
}

function blockquoteToDoc(quote: Blockquote, source: string): JSONContent {
  const kind = calloutKindOf(quote)
  return kind ? calloutToDoc(quote, kind, source) : { type: 'blockquote', content: blocksToDoc(quote.children, source) }
}

function tableToDoc(table: Table, source: string): JSONContent {
  return {
    type: 'table',
    attrs: { align: table.align ?? null },
    content: table.children.map((row, rowIndex) => ({
      type: 'tableRow',
      content: row.children.map((cell) => ({
        type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
        content: [textblock('paragraph', cell.children, source)],
      })),
    })),
  }
}

function codeToDoc(code: Code): JSONContent {
  const attrs = { language: code.lang ?? null, meta: code.meta ?? null }
  return code.value === '' ? { type: 'codeBlock', attrs } : { type: 'codeBlock', attrs, content: [{ type: 'text', text: code.value }] }
}

export function blockToDoc(node: RootContent, source: string): JSONContent {
  switch (node.type) {
    case 'paragraph': return textblock('paragraph', node.children, source)
    case 'heading': return textblock('heading', node.children, source, { level: node.depth })
    case 'thematicBreak': return { type: 'horizontalRule' }
    case 'blockquote': return blockquoteToDoc(node, source)
    case 'list': return listToDoc(node, source)
    case 'code': return codeToDoc(node)
    case 'table': return tableToDoc(node, source)
    case 'html': return { type: 'rawBlock', attrs: { source: node.value } }
    default: return { type: 'rawBlock', attrs: { source: markdownSourceOf(node, source) } }
  }
}
