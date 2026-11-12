/**
 * Heading ids and the outline. Each heading's DOM node carries `id` = a stable slug of its text (`h-` + the
 * words, `-1`, `-2` … for repeats), set as a ProseMirror node decoration so it never enters the document.
 */
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

interface Heading { readonly id: string; readonly level: number; readonly text: string; readonly pos: number; readonly size: number }

/** `h-` keeps a heading such as "Root" or "Main" from colliding with the app's own element ids. */
function slugify(text: string): string {
  const words = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replaceAll(' ', '-')
  return `h-${words === '' ? 'section' : words}`
}

export function headingsOf(doc: PMNode): Heading[] {
  const seen = new Map<string, number>()
  const headings: Heading[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    const slug = slugify(node.textContent)
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    const level: unknown = node.attrs.level
    headings.push({ id: count === 0 ? slug : `${slug}-${count}`, level: typeof level === 'number' ? level : 1, text: node.textContent, pos, size: node.nodeSize })
    return false
  })
  return headings
}

const key = new PluginKey<DecorationSet>('canvasHeadingIds')

const decorate = (doc: PMNode) =>
  DecorationSet.create(doc, headingsOf(doc).map((heading) => Decoration.node(heading.pos, heading.pos + heading.size, { id: heading.id })))

export const HeadingIds = Extension.create({
  name: 'canvasHeadingIds',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, previous) => (tr.docChanged ? decorate(tr.doc) : previous),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ]
  },
})
