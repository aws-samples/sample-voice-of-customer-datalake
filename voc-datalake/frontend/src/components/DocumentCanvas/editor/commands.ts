/**
 * The canvas's commands as the page's menu bar (Edit, Format, Insert) asks for them: the editor's own actions, the
 * same ones its keys, the "/" menu, the format bar and the link / image popovers run. Nothing here is new editing
 * behaviour: undo / redo are the editor's history, the marks and blocks are blocks.ts's, Link and Image open the
 * popovers Mod+K and the "/" menu open.
 */
import type { Editor } from '@tiptap/core'
import { applyBlock, turnInto, type BlockId } from './blocks'
import type { CanvasController } from './controller'

/** A mark the format bar toggles. */
type MarkCommand = 'bold' | 'italic' | 'strike' | 'code'

export type CanvasCommand = 'undo' | 'redo' | MarkCommand | 'link' | BlockId

/** Blocks the current block turns into (blocks.ts `turnInto`: a quote or callout around it is left first). */
const TURNED_INTO: ReadonlySet<BlockId> = new Set(['paragraph', 'heading1', 'heading2', 'heading3', 'blockquote', 'callout',
  'bulletList', 'orderedList', 'taskList', 'codeBlock'])

const usable = (editor: Editor | null): editor is Editor => editor !== null && !editor.isDestroyed && editor.isEditable

export function toggleMark(editor: Editor, mark: MarkCommand): boolean {
  const chain = editor.chain().focus()
  switch (mark) {
    case 'bold': return chain.toggleBold().run()
    case 'italic': return chain.toggleItalic().run()
    case 'strike': return chain.toggleStrike().run()
    case 'code': return chain.toggleCode().run()
  }
}

/** Whether `command` can run now (an editable canvas; undo / redo with something to undo / redo). */
export function canRunCommand(editor: Editor | null, command: CanvasCommand): boolean {
  if (!usable(editor)) return false
  if (command === 'undo') return editor.can().undo()
  if (command === 'redo') return editor.can().redo()
  return true
}

/** Run `command` on the text at its selection (focus goes back to it); false when it could not run. */
export function runCommand(editor: Editor | null, controller: CanvasController, command: CanvasCommand): boolean {
  if (!usable(editor)) return false
  switch (command) {
    case 'undo': return editor.chain().focus().undo().run()
    case 'redo': return editor.chain().focus().redo().run()
    case 'bold': case 'italic': case 'strike': case 'code': return toggleMark(editor, command)
    case 'link':
      // The popover opens on the selection, as Mod+K does (and once it has loaded, if it had not yet).
      controller.openLink()
      return true
    case 'image':
      controller.openImage()
      return true
    default:
      if (TURNED_INTO.has(command)) {
        turnInto(editor, command)
        return true
      }
      return applyBlock(editor.chain().focus(), command).run()
  }
}
