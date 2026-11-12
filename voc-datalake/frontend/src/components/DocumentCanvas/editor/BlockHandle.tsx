/**
 * The grip beside the block under the pointer: drag it to move the block, click it for the block menu. Keyboard
 * users get the same menu with Alt+Shift+M and move blocks with Alt+Shift+Up/Down (controller.ts).
 */
import type { Editor } from '@tiptap/core'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import { GripVertical } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface BlockHandleProps {
  readonly editor: Editor
  readonly onOpenMenu: (pos: number) => void
}

export default function BlockHandle({ editor, onOpenMenu }: BlockHandleProps) {
  const { t } = useTranslation('projectDetail')
  const hovered = useRef<number | null>(null)
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
