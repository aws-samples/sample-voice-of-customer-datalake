/**
 * ProseMirror inline content (flat text runs with marks) -> nested mdast phrasing.
 * A run keeps the marks already open around it when it can; new marks open outermost-first by how far they
 * reach ahead, so `*a **b***` comes back as emphasis(a, strong(b)), not as two emphasis nodes.
 */
import type { JSONContent } from '@tiptap/core'
import type { Delete, Emphasis, Link, PhrasingContent, Strong } from 'mdast'
import './mdastTypes'
import { attrString } from './attrs'

type Mark = NonNullable<JSONContent['marks']>[number]
type Wrapper = Emphasis | Strong | Delete | Link
interface Frame { readonly key: string; readonly node: Wrapper }

const RANK = ['link', 'bold', 'italic', 'strike']

function markKey(mark: Mark): string {
  return mark.type === 'link'
    ? `link\u0000${attrString(mark.attrs, 'href') ?? ''}\u0000${attrString(mark.attrs, 'title') ?? ''}`
    : mark.type
}

/** The wrapping marks of a run (inline code is a leaf in mdast, not a wrapper). */
function wrappingMarks(node: JSONContent): readonly Mark[] {
  return (node.marks ?? []).filter((mark) => RANK.includes(mark.type))
}

function wrapperOf(mark: Mark): Wrapper {
  switch (mark.type) {
    case 'link': return { type: 'link', url: attrString(mark.attrs, 'href') ?? '', title: attrString(mark.attrs, 'title'), children: [] }
    case 'bold': return { type: 'strong', children: [] }
    case 'italic': return { type: 'emphasis', children: [] }
    default: return { type: 'delete', children: [] }
  }
}

function leafOf(node: JSONContent): PhrasingContent | null {
  switch (node.type) {
    case 'text': {
      const value = node.text ?? ''
      if (value === '') return null
      return (node.marks ?? []).some((mark) => mark.type === 'code') ? { type: 'inlineCode', value } : { type: 'text', value }
    }
    case 'hardBreak': return { type: 'break' }
    case 'image':
      return { type: 'image', url: attrString(node.attrs, 'src') ?? '', title: attrString(node.attrs, 'title'), alt: attrString(node.attrs, 'alt') }
    case 'rawInline': return { type: 'rawInline', value: attrString(node.attrs, 'source') ?? '' }
    default: return null
  }
}

/** How many runs from `index` on carry the mark `key`. */
function reach(keys: readonly (readonly string[])[], index: number, key: string): number {
  const end = keys.slice(index).findIndex((runKeys) => !runKeys.includes(key))
  return end === -1 ? keys.length - index : end
}

function keptDepth(stack: readonly Frame[], wanted: readonly string[]): number {
  const firstMissing = stack.findIndex((frame) => !wanted.includes(frame.key))
  return firstMissing === -1 ? stack.length : firstMissing
}

export function inlineToMdast(content: readonly JSONContent[]): PhrasingContent[] {
  const root: PhrasingContent[] = []
  const marks = content.map(wrappingMarks)
  const keys = marks.map((runMarks) => runMarks.map(markKey))
  const stack: Frame[] = []
  content.forEach((node, index) => {
    const wanted = keys[index] ?? []
    stack.splice(keptDepth(stack, wanted))
    const open = new Set(stack.map((frame) => frame.key))
    const toOpen = (marks[index] ?? [])
      .filter((mark) => !open.has(markKey(mark)))
      .sort((a, b) => reach(keys, index, markKey(b)) - reach(keys, index, markKey(a))
        || RANK.indexOf(a.type) - RANK.indexOf(b.type))
    toOpen.forEach((mark) => {
      const wrapper = wrapperOf(mark)
      ;(stack.at(-1)?.node.children ?? root).push(wrapper)
      stack.push({ key: markKey(mark), node: wrapper })
    })
    const leaf = leafOf(node)
    if (leaf) (stack.at(-1)?.node.children ?? root).push(leaf)
  })
  return root
}
