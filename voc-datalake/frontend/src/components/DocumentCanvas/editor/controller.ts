/**
 * The canvas's keyboard wiring: one extension that hands keys to whichever popover is open (the "/" menu sees
 * arrows, Enter and Esc before ProseMirror does), plus the shortcuts: Mod+K (link), Alt+F10 (format bar),
 * Alt+Shift+M (block menu), Alt+Shift+Up/Down (move the block).
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { currentBlock, moveBlock } from './blockActions'

type KeyHandler = (event: KeyboardEvent) => boolean

/** Where the pointer last was over the canvas (viewport coordinates), and the mouse buttons held then. */
export interface Pointer { readonly x: number; readonly y: number; readonly buttons: number }

/** How long a shortcut pressed before its menu loaded is still answered: later, the person has moved on. */
export const SHORTCUT_WAIT_MS = 1000

/** A request kept for a component that has not registered yet: when it was made, and what it asks. */
interface Waiting<T> { readonly at: number; readonly request: T }

/** The block menu waits for "the block at the caret", read when it opens (the text may have changed meanwhile). */
interface WaitingRequests {
  link: Waiting<true> | null
  toolbar: Waiting<true> | null
  blockMenu: Waiting<() => number | null> | null
}

/**
 * Who answers the canvas's keys: the components register themselves while they are mounted. The popovers and the
 * format bar load after the text (CanvasChrome.tsx): a shortcut pressed before they are there is kept, the last of
 * each kind, and answered when its component registers within SHORTCUT_WAIT_MS, so Mod+K in the first moments still
 * opens the link editor; one answered later would open on whatever the person is doing by then, so it is dropped.
 */
export class CanvasController {
  private slash: KeyHandler | null = null
  private link: (() => void) | null = null
  private toolbar: (() => void) | null = null
  private blockMenu: ((pos: number) => void) | null = null
  private pointer: Pointer | null = null
  private readonly waiting: WaitingRequests = { link: null, toolbar: null, blockMenu: null }

  /** The canvas notes the pointer from the start, so the block handle, which loads later, shows where it already is. */
  setPointer(pointer: Pointer | null) { this.pointer = pointer }
  lastPointer(): Pointer | null { return this.pointer }

  /** The request kept for `kind`, if still recent, and none kept any more. */
  private take<K extends keyof WaitingRequests>(kind: K): WaitingRequests[K] {
    const kept = this.waiting[kind]
    this.waiting[kind] = null
    return kept !== null && Date.now() - kept.at <= SHORTCUT_WAIT_MS ? kept : null
  }

  setSlashKeyDown(handler: KeyHandler | null) { this.slash = handler }
  setOpenLink(handler: (() => void) | null) {
    this.link = handler
    if (handler && this.take('link')) handler()
  }
  setFocusToolbar(handler: (() => void) | null) {
    this.toolbar = handler
    if (handler && this.take('toolbar')) handler()
  }
  setOpenBlockMenu(handler: ((pos: number) => void) | null) {
    this.blockMenu = handler
    const kept = handler ? this.take('blockMenu') : null
    const pos = kept ? kept.request() : null
    if (handler && pos !== null) handler(pos)
  }

  slashKeyDown(event: KeyboardEvent): boolean { return this.slash?.(event) ?? false }
  openLink(): void {
    if (this.link) this.link()
    else this.waiting.link = { at: Date.now(), request: true }
  }
  focusToolbar(): void {
    if (this.toolbar) this.toolbar()
    else this.waiting.toolbar = { at: Date.now(), request: true }
  }
  /** The block menu of the block at `pos` (the grip: only there once the menus are). */
  openBlockMenu(pos: number): void { this.blockMenu?.(pos) }
  /** The block menu of the block `block()` names now, or as soon as the menus are there (the keyboard path). */
  openBlockMenuOf(block: () => number | null): void {
    if (!this.blockMenu) {
      this.waiting.blockMenu = { at: Date.now(), request: block }
      return
    }
    const pos = block()
    if (pos !== null) this.blockMenu(pos)
  }
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
        const atCaret = () => (editor.isEditable && !editor.isDestroyed ? currentBlock(editor) : null)
        const block = atCaret()
        if (block !== null) controller().openBlockMenuOf(atCaret)
        return block !== null
      },
      'Alt-Shift-ArrowUp': ({ editor }) => moveCurrent(editor, -1),
      'Alt-Shift-ArrowDown': ({ editor }) => moveCurrent(editor, 1),
    }
  },
})
