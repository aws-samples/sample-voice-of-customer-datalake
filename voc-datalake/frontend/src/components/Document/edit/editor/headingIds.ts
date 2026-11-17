/**
 * Heading ids and the outline. Each heading's DOM node carries `id` = a stable slug of its text (`h-` + the
 * words, `-1`, `-2` … for repeats: components/Document/headingSlug.ts, the light reader's rule too), set as a
 * ProseMirror node decoration so it never enters the document.
 *
 * The ids depend only on the headings' text and order, so a change that touches no heading (typing in a paragraph of
 * a long document) keeps them: the decorations move with the text and the outline stays the same array; only a change
 * in or around a heading walks the document again.
 */
import { Extension, getChangedRanges } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, type Step } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { headingId } from '../../headingSlug'

interface Heading { readonly id: string; readonly level: number; readonly text: string; readonly pos: number; readonly size: number }

const isHeading = (node: PMNode) => node.type.name === 'heading'

export function headingsOf(doc: PMNode): Heading[] {
  const seen = new Map<string, number>()
  const headings: Heading[] = []
  doc.descendants((node, pos) => {
    // A heading may sit in a list or a quote; the text inside a paragraph holds none.
    if (!isHeading(node)) return !node.isTextblock
    const level: unknown = node.attrs.level
    headings.push({ id: headingId(seen, node.textContent), level: typeof level === 'number' ? level : 1, text: node.textContent, pos, size: node.nodeSize })
    return false
  })
  return headings
}

/** The document's headings (positions as of when they were read) and their id decorations. */
interface HeadingState { readonly headings: readonly Heading[]; readonly decorations: DecorationSet }

const key = new PluginKey<HeadingState>('canvasHeadingIds')

function read(doc: PMNode): HeadingState {
  const headings = headingsOf(doc)
  const decorations = DecorationSet.create(doc, headings.map((heading) => Decoration.node(heading.pos, heading.pos + heading.size, { id: heading.id })))
  return { headings, decorations }
}

function holdsHeading(doc: PMNode, from: number, to: number): boolean {
  const seen = { heading: false }
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node) => {
    if (isHeading(node)) seen.heading = true
    return !seen.heading && !node.isTextblock
  })
  return seen.heading
}

/** Steps whose map covers every node they change (attribute steps have an empty map); marks never change a heading's text. */
const mapped = (step: Step) =>
  step instanceof ReplaceStep || step instanceof ReplaceAroundStep || step instanceof AddMarkStep || step instanceof RemoveMarkStep

/** Whether the change wrote in, removed, added or reshaped a heading (before or after it). */
function touchesHeading(tr: Transaction): boolean {
  if (!tr.steps.every(mapped)) return true
  return getChangedRanges(tr).some(({ oldRange, newRange }) =>
    holdsHeading(tr.before, oldRange.from, oldRange.to) || holdsHeading(tr.doc, newRange.from, newRange.to))
}

function applyHeadings(tr: Transaction, previous: HeadingState): HeadingState {
  if (!tr.docChanged) return previous
  if (touchesHeading(tr)) return read(tr.doc)
  // Same headings, same ids: the decorations only move. `headings` keeps its identity (the outline is unchanged).
  return { headings: previous.headings, decorations: previous.decorations.map(tr.mapping, tr.doc) }
}

/** The headings HeadingIds last read (the same array while no heading changed); their `pos` may be stale. */
export function headingsIn(state: EditorState): readonly Heading[] {
  return key.getState(state)?.headings ?? headingsOf(state.doc)
}

export const HeadingIds = Extension.create({
  name: 'canvasHeadingIds',
  addProseMirrorPlugins() {
    return [
      new Plugin<HeadingState>({
        key,
        state: {
          init: (_config, state) => read(state.doc),
          apply: (tr, previous) => applyHeadings(tr, previous),
        },
        props: { decorations: (state) => key.getState(state)?.decorations },
      }),
    ]
  },
})
