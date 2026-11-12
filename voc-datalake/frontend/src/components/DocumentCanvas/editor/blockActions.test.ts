import { NodeSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { currentBlock, deleteBlock, duplicateBlock, moveBlock, selectBlock } from './blockActions'
import { blockPos, headlessEditor, markdownOf } from './headless-editor-fixtures'

const THREE = 'One\n\nTwo\n\nThree'

describe('currentBlock', () => {
  it('is the top-level block the caret is in', () => {
    const editor = headlessEditor(THREE)
    editor.commands.setTextSelection(blockPos(editor, 1) + 2)
    expect(currentBlock(editor)).toBe(blockPos(editor, 1))
  })

  it('is the innermost list item around the caret, not the whole list', () => {
    const editor = headlessEditor('- One\n- Two')
    const list = editor.state.doc.child(0)
    const second = 1 + list.child(0).nodeSize
    editor.commands.setTextSelection(second + 3)
    expect(currentBlock(editor)).toBe(second)
    expect(editor.state.doc.nodeAt(second)?.type.name).toBe('listItem')
  })

  it('is the to-do item around the caret', () => {
    const editor = headlessEditor('- [ ] One\n- [x] Two')
    editor.commands.setTextSelection(4)
    const pos = currentBlock(editor)
    expect(pos).toBe(1)
    expect(editor.state.doc.nodeAt(pos ?? -1)?.type.name).toBe('taskItem')
  })

  it('is the selected atom when a divider is selected at the top level', () => {
    const editor = headlessEditor('One\n\n---\n\nTwo')
    const rule = blockPos(editor, 1)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, rule)))
    expect(currentBlock(editor)).toBe(rule)
  })
})

describe('moveBlock', () => {
  it('moves a block down past its next sibling, the caret with it', () => {
    const editor = headlessEditor(THREE)
    editor.commands.setTextSelection(3)
    expect(moveBlock(editor, 0, 1)).toBe(true)
    expect(markdownOf(editor)).toBe('Two\n\nOne\n\nThree')
    expect(editor.state.selection.$from.parent.textContent).toBe('One')
    expect(editor.state.selection.$from.parentOffset).toBe(2)
  })

  it('moves a block up past its previous sibling', () => {
    const editor = headlessEditor(THREE)
    const last = blockPos(editor, 2)
    editor.commands.setTextSelection(last + 1)
    expect(moveBlock(editor, last, -1)).toBe(true)
    expect(markdownOf(editor)).toBe('One\n\nThree\n\nTwo')
    expect(editor.state.selection.$from.parent.textContent).toBe('Three')
  })

  it('moves a list item within its list', () => {
    const editor = headlessEditor('- One\n- Two')
    expect(moveBlock(editor, 1, 1)).toBe(true)
    expect(markdownOf(editor)).toBe('- Two\n- One')
  })

  it('refuses at the edges and where there is no block, changing nothing', () => {
    const editor = headlessEditor(THREE)
    expect(moveBlock(editor, 0, -1)).toBe(false)
    expect(moveBlock(editor, blockPos(editor, 2), 1)).toBe(false)
    expect(moveBlock(editor, editor.state.doc.content.size, 1)).toBe(false)
    expect(markdownOf(editor)).toBe(THREE)
  })
})

describe('duplicateBlock and deleteBlock', () => {
  it('puts a copy of the block right after it', () => {
    const editor = headlessEditor(THREE)
    expect(duplicateBlock(editor, blockPos(editor, 1))).toBe(true)
    expect(markdownOf(editor)).toBe('One\n\nTwo\n\nTwo\n\nThree')
  })

  it('deletes the block and leaves the caret where it was', () => {
    const editor = headlessEditor(THREE)
    const second = blockPos(editor, 1)
    expect(deleteBlock(editor, second)).toBe(true)
    expect(markdownOf(editor)).toBe('One\n\nThree')
    expect(editor.state.selection.$from.parent.textContent).toBe('Three')
  })

  it('deletes the last block without leaving the document', () => {
    const editor = headlessEditor(THREE)
    expect(deleteBlock(editor, blockPos(editor, 2))).toBe(true)
    expect(markdownOf(editor)).toBe('One\n\nTwo')
  })

  it('refuses where there is no block', () => {
    const editor = headlessEditor(THREE)
    const end = editor.state.doc.content.size
    expect(duplicateBlock(editor, end)).toBe(false)
    expect(deleteBlock(editor, end)).toBe(false)
    expect(markdownOf(editor)).toBe(THREE)
  })
})

describe('selectBlock', () => {
  it('puts the caret at the start of a text block', () => {
    const editor = headlessEditor(THREE)
    selectBlock(editor, blockPos(editor, 2))
    const { selection } = editor.state
    expect(selection.empty).toBe(true)
    expect(selection.$from.parent.textContent).toBe('Three')
    expect(selection.$from.parentOffset).toBe(0)
  })

  it('selects an atom (a divider) whole', () => {
    const editor = headlessEditor('One\n\n---\n\nTwo')
    const rule = blockPos(editor, 1)
    selectBlock(editor, rule)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(rule)
  })

  it('leaves the selection alone where there is no block', () => {
    const editor = headlessEditor(THREE)
    editor.commands.setTextSelection(2)
    selectBlock(editor, editor.state.doc.content.size)
    expect(editor.state.selection.from).toBe(2)
  })
})
