/** Block-level actions shared by the block handle's menu and the keyboard (Alt+Shift+Arrow moves the block). */
import type { Editor } from '@tiptap/core'
import { type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

/** Where the block a position belongs to starts: the innermost list item around it, else the top-level block. */
function blockAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size))
  const depths = Array.from({ length: $pos.depth }, (_, index) => $pos.depth - index)
  const item = depths.find((depth) => ['listItem', 'taskItem'].includes($pos.node(depth).type.name))
  const depth = item ?? ($pos.depth >= 1 ? 1 : null)
  if (depth === null) return $pos.nodeAfter ? $pos.pos : null
  return $pos.before(depth)
}

/** The start position of the block the selection is in (null when there is none). */
export const currentBlock = (editor: Editor) => blockAt(editor.state.doc, editor.state.selection.from)

/** Swap the block at `pos` with its previous (-1) or next (+1) sibling; the caret moves with it. */
export function moveBlock(editor: Editor, pos: number, direction: -1 | 1): boolean {
  const { state } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return false
  const $pos = state.doc.resolve(pos)
  const index = $pos.index()
  const sibling = $pos.parent.maybeChild(index + direction)
  if (!sibling) return false
  const offset = Math.min(Math.max(state.selection.from - pos, 0), node.nodeSize - 1)
  const target = direction === -1 ? pos - sibling.nodeSize : pos + sibling.nodeSize
  const tr = state.tr.delete(pos, pos + node.nodeSize).insert(target, node)
  const caret = tr.doc.resolve(Math.min(target + offset, tr.doc.content.size))
  editor.view.dispatch(tr.setSelection(TextSelection.near(caret)).scrollIntoView())
  return true
}

export function duplicateBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return false
  editor.view.dispatch(editor.state.tr.insert(pos + node.nodeSize, node.copy(node.content)).scrollIntoView())
  return true
}

export function deleteBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return false
  const tr = editor.state.tr.delete(pos, pos + node.nodeSize)
  editor.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)))))
  return true
}

/** Put the caret in the block at `pos` (a text block's start; an atom is selected whole). */
export function selectBlock(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  const selection = node.isAtom ? NodeSelection.create(editor.state.doc, pos) : TextSelection.near(editor.state.doc.resolve(pos + 1))
  editor.view.dispatch(editor.state.tr.setSelection(selection))
}
