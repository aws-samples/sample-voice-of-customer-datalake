/**
 * @fileoverview A canvas editor without React or its chrome, for the specs of the block commands, the block actions
 * and the canvas's own nodes: the same schema (markdown/extensions.ts), Markdown in through markdownToDoc and out
 * through docToMarkdown, so each spec reads what a save would store.
 */
import { Editor } from '@tiptap/core'
import { afterEach, beforeAll } from 'vitest'
import { stubRangeLayout } from '@test/stubRangeLayout'
import { markdownToDoc, docToMarkdown } from '../markdown/convert'
import { canvasExtensions } from '../markdown/extensions'

const CALLOUT_LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' } as const

// ProseMirror measures the caret when it takes the focus (coordsAtPos); jsdom gives a Range no boxes at all.
beforeAll(() => stubRangeLayout())

const mounted: { editor: Editor; element: HTMLElement }[] = []
afterEach(() => {
  mounted.splice(0).forEach(({ editor, element }) => {
    editor.destroy()
    element.remove()
  })
})

/**
 * A canvas without its chrome showing `markdown` (or `html`, for the parse rules), in the page (so it can take the
 * focus); destroyed after the test.
 */
export function headlessEditor(content: string, as: 'markdown' | 'html' = 'markdown'): Editor {
  const element = document.body.appendChild(document.createElement('div'))
  const editor = new Editor({
    element,
    extensions: canvasExtensions({ placeholder: '', calloutLabels: CALLOUT_LABELS, taskLabel: () => 'Done', emptyClass: 'empty' }),
    content: as === 'markdown' ? markdownToDoc(content) : content,
  })
  mounted.push({ editor, element })
  return editor
}

/** What a save of the editor's content would store, without the serializer's final newline. */
export const markdownOf = (editor: Editor): string => docToMarkdown(editor.getJSON()).replace(/\n$/, '')

/** The start position of the top-level block at `index`. */
export function blockPos(editor: Editor, index: number): number {
  return Array.from({ length: index }, (_, at) => editor.state.doc.child(at).nodeSize).reduce((sum, size) => sum + size, 0)
}
