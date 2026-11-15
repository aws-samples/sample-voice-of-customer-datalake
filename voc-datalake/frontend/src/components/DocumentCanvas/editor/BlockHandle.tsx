/**
 * The grip beside the block under the pointer: drag it to move the block, click it for the block menu. Keyboard
 * users get the same menu with Alt+Shift+M and move blocks with Alt+Shift+Up/Down (controller.ts).
 *
 * It loads after the text (CanvasChrome.tsx): a pointer already over a block then gets its grip at once, as a move
 * would, instead of on its next move.
 */
import type { Editor } from '@tiptap/core'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import { GripVertical } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Pointer } from './controller'

interface BlockHandleProps {
  readonly editor: Editor
  readonly onOpenMenu: (pos: number) => void
  readonly lastPointer: () => Pointer | null
}

export default function BlockHandle({ editor, onOpenMenu, lastPointer }: BlockHandleProps) {
  const { t } = useTranslation('projectDetail')
  const hovered = useRef<number | null>(null)
  // DragHandle registers its plugin in its own effect, which runs before this one. Never while a button is held: a
  // move then belongs to a selection or a drag in progress.
  useEffect(() => {
    const at = lastPointer()
    if (at?.buttons === 0 && !editor.isDestroyed) {
      editor.view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: at.x, clientY: at.y, bubbles: true }))
    }
  }, [editor, lastPointer])
  return (
    <DragHandle
      editor={editor}
      className="canvas-handle"
      onNodeChange={({ node, pos }) => {
        hovered.current = node ? pos : null
      }}
    >
      <div
        role="button"
        aria-label={t('canvas.editor.handle.label')}
        aria-haspopup="menu"
        aria-keyshortcuts="Alt+Shift+M"
        title={t('canvas.editor.handle.label')}
        className="canvas-handle__grip"
        onClick={() => {
          if (hovered.current !== null) onOpenMenu(hovered.current)
        }}
      >
        <GripVertical aria-hidden="true" className="canvas-handle__icon" />
      </div>
    </DragHandle>
  )
}
