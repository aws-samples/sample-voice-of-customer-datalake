/**
 * HeadingIds: the ids and the outline after every kind of change are what reading the whole document gives, and a
 * change that touches no heading reads nothing again (the outline is the same array, so nothing is published).
 */
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { markdownToDoc } from '../markdown/convert'
import { canvasExtensions } from '../markdown/extensions'
import { largeMarkdown } from '../markdown/large-document-fixtures'
import { HeadingIds, headingsIn, headingsOf } from './headingIds'

const LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' } as const
const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.view.dom.parentElement?.remove()
    editor.destroy()
  })
})

function editorOf(markdown: string): Editor {
  const element = document.body.appendChild(document.createElement('div'))
  const editor = new Editor({
    element,
    extensions: [...canvasExtensions({ placeholder: '', calloutLabels: LABELS, taskLabel: () => 'Done', emptyClass: 'empty' }), HeadingIds],
    content: markdownToDoc(markdown),
  })
  editors.push(editor)
  return editor
}

const ids = (editor: Editor) => [...editor.view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => heading.id)
const outline = (editor: Editor) => headingsIn(editor.state).map(({ id, level, text }) => ({ id, level, text }))

/** What reading the whole document now gives: the ids, in order, and the outline. */
function expectFresh(editor: Editor) {
  const fresh = headingsOf(editor.state.doc)
  expect(outline(editor)).toStrictEqual(fresh.map(({ id, level, text }) => ({ id, level, text })))
  expect(ids(editor)).toStrictEqual(fresh.map((heading) => heading.id))
}

/** The position just inside the first top-level block whose text starts with `start`. */
function inside(editor: Editor, start: string): number {
  const starts: number[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent.startsWith(start)) starts.push(offset + 1)
  })
  return starts[0] ?? -1
}

describe('HeadingIds', () => {
  it('keeps the same headings (no new outline) while the typing is in a paragraph of a long document', () => {
    const editor = editorOf(largeMarkdown(60_000))
    const before = headingsIn(editor.state)

    editor.commands.insertContentAt(inside(editor, 'Customers in segment 40 '), 'More text ')
    editor.commands.insertContentAt(inside(editor, 'Customers in segment 2 '), 'x')

    expect(headingsIn(editor.state)).toBe(before)
    expectFresh(editor)
  })

  it.each<[string, (editor: Editor) => void]>([
    ['typing in a heading', (editor) => { editor.commands.insertContentAt(inside(editor, 'Risks'), 'Top ') }],
    ['a paragraph turned into a heading', (editor) => { editor.chain().setTextSelection(inside(editor, 'Body')).setNode('heading', { level: 2 }).run() }],
    ['a heading turned into a paragraph', (editor) => { editor.chain().setTextSelection(inside(editor, 'Risks')).setNode('paragraph').run() }],
    ['a heading deleted', (editor) => {
      const from = inside(editor, 'Risks') - 1
      editor.commands.deleteRange({ from, to: from + (editor.state.doc.nodeAt(from)?.nodeSize ?? 0) })
    }],
    ['a heading inserted', (editor) => { editor.commands.insertContentAt(inside(editor, 'Body') - 1, '<h2>Risks</h2>') }],
    ['a heading level set as an attribute', (editor) => {
      const pos = inside(editor, 'Risks') - 1
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'level', 3))
    }],
    // Inside the list, its item, then the heading.
    ['a heading in a list item', (editor) => { editor.commands.insertContentAt(inside(editor, 'Item') + 2, 'Risks ') }],
    ['a heading moved by undo', (editor) => {
      editor.commands.insertContentAt(inside(editor, 'Risks'), 'Old ')
      editor.commands.undo()
    }],
  ])('reads the headings again after %s', (_name, change) => {
    const editor = editorOf('# Plan\n\nBody\n\n## Risks\n\nMore\n\n## Risks\n\n- # Item heading\n\nEnd')
    const before = headingsIn(editor.state)

    change(editor)

    expect(headingsIn(editor.state)).not.toBe(before)
    expectFresh(editor)
  })

  it('moves the ids with the text when the typing is above a heading', () => {
    const editor = editorOf('Intro\n\n## Risks\n\n## Risks')
    editor.commands.insertContentAt(inside(editor, 'Intro'), 'Longer intro ')
    editor.commands.insertContentAt(inside(editor, 'Longer'), '\n')

    expectFresh(editor)
    expect(ids(editor)).toStrictEqual(['h-risks', 'h-risks-1'])
  })
})
