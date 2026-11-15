/** Where a popover goes: below a document position, in the canvas's own coordinates (so it scrolls with it). */
import type { Editor } from '@tiptap/core'

export interface Anchor { readonly top: number; readonly left: number }

export function anchorAt(editor: Editor, pos: number, container: HTMLElement | null): Anchor {
  const box = container?.getBoundingClientRect()
  try {
    const coords = editor.view.coordsAtPos(Math.min(pos, editor.state.doc.content.size))
    return { top: coords.bottom - (box?.top ?? 0) + 4, left: Math.max(0, coords.left - (box?.left ?? 0)) }
  } catch {
    // No layout (a hidden canvas): open at the top of the canvas.
    return { top: 0, left: 0 }
  }
}
