/**
 * The canvas's keyboard wiring: one extension that hands keys to whichever popover is open (the "/" menu sees
 * arrows, Enter and Esc before ProseMirror does), plus the shortcuts: Mod+K (link), Alt+F10 (format bar),
 * Alt+Shift+M (block menu), Alt+Shift+Up/Down (move the block).
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { currentBlock, moveBlock } from './blockActions'

type KeyHandler = (event: KeyboardEvent) => boolean

/** Who answers the canvas's keys: the components register themselves while they are mounted. */
export class CanvasController {
  private slash: KeyHandler | null = null
  private link: (() => void) | null = null
  private toolbar: (() => void) | null = null
  private blockMenu: ((pos: number) => void) | null = null

  setSlashKeyDown(handler: KeyHandler | null) { this.slash = handler }
  setOpenLink(handler: (() => void) | null) { this.link = handler }
  setFocusToolbar(handler: (() => void) | null) { this.toolbar = handler }
  setOpenBlockMenu(handler: ((pos: number) => void) | null) { this.blockMenu = handler }

  slashKeyDown(event: KeyboardEvent): boolean { return this.slash?.(event) ?? false }
  openLink(): void { this.link?.() }
  focusToolbar(): void { this.toolbar?.() }
  openBlockMenu(pos: number): void { this.blockMenu?.(pos) }
}

const moveCurrent = (editor: Editor, direction: -1 | 1) => {
  const block = editor.isEditable ? currentBlock(editor) : null
  return block === null ? false : moveBlock(editor, block, direction)
}

/** `controller` is a getter: TipTap deep-copies plain option objects, which would cut the link to the live one. */
export const CanvasKeys = Extension.create<{ controller: () => CanvasController }>({
  name: 'canvasKeys',
  priority: 1000,

  addOptions() {
    const fallback = new CanvasController()
    return { controller: () => fallback }
  },

  addProseMirrorPlugins() {
    const { controller } = this.options
    return [new Plugin({ key: new PluginKey('canvasKeys'), props: { handleKeyDown: (_view, event) => controller().slashKeyDown(event) } })]
  },

  addKeyboardShortcuts() {
    const { controller } = this.options
    return {
      'Mod-k': () => {
        controller().openLink()
        return true
      },
      'Alt-F10': () => {
        controller().focusToolbar()
        return true
      },
      'Alt-Shift-m': ({ editor }) => {
        const block = editor.isEditable ? currentBlock(editor) : null
        if (block !== null) controller().openBlockMenu(block)
        return block !== null
      },
      'Alt-Shift-ArrowUp': ({ editor }) => moveCurrent(editor, -1),
      'Alt-Shift-ArrowDown': ({ editor }) => moveCurrent(editor, 1),
    }
  },
})
