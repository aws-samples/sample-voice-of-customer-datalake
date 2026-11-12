/** The block menu (from the block handle, or Alt+Shift+M at the caret): move, turn into, duplicate, delete. */
import type { Editor } from '@tiptap/core'
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Repeat2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deleteBlock, duplicateBlock, moveBlock, selectBlock } from './blockActions'
import { TURN_INTO_BLOCKS, turnInto } from './blocks'
import type { Anchor } from './floating'
import MenuList, { type MenuItem } from './MenuList'

interface BlockMenuProps {
  readonly editor: Editor
  readonly pos: number
  readonly anchor: Anchor
  readonly onClose: () => void
}

function siblings(editor: Editor, pos: number) {
  const $pos = editor.state.doc.resolve(pos)
  return { first: $pos.index() === 0, last: $pos.index() >= $pos.parent.childCount - 1 }
}

export default function BlockMenu({ editor, pos, anchor, onClose }: BlockMenuProps) {
  const { t } = useTranslation('projectDetail')
  const [turning, setTurning] = useState(false)
  const node = editor.state.doc.nodeAt(pos)
  const { first, last } = siblings(editor, pos)

  const done = (action: () => void) => () => {
    action()
    onClose()
    editor.commands.focus()
  }

  const close = () => {
    onClose()
    editor.commands.focus()
  }

  const main: MenuItem[] = [
    { id: 'up', label: t('canvas.editor.handle.moveUp'), icon: ArrowUp, disabled: first, onSelect: done(() => moveBlock(editor, pos, -1)) },
    { id: 'down', label: t('canvas.editor.handle.moveDown'), icon: ArrowDown, disabled: last, onSelect: done(() => moveBlock(editor, pos, 1)) },
    { id: 'turn', label: t('canvas.editor.handle.turnInto'), icon: Repeat2, disabled: !node?.isTextblock, submenu: true, onSelect: () => setTurning(true) },
    { id: 'duplicate', label: t('canvas.editor.handle.duplicate'), icon: Copy, onSelect: done(() => duplicateBlock(editor, pos)) },
    { id: 'delete', label: t('canvas.editor.handle.delete'), icon: Trash2, onSelect: done(() => deleteBlock(editor, pos)) },
  ]
  const turnItems: MenuItem[] = [
    { id: 'back', label: t('canvas.editor.handle.back'), icon: ArrowLeft, onSelect: () => setTurning(false) },
    ...TURN_INTO_BLOCKS.map((block) => ({
      id: block.id,
      label: t(`canvas.editor.blocks.${block.id}`),
      icon: block.icon,
      onSelect: done(() => {
        selectBlock(editor, pos)
        turnInto(editor, block.id)
      }),
    })),
  ]

  return (
    <div className="canvas-floating" style={{ top: anchor.top, left: anchor.left }}>
      <MenuList label={turning ? t('canvas.editor.handle.turnInto') : t('canvas.editor.handle.menu')} items={turning ? turnItems : main} onClose={turning ? () => setTurning(false) : close} />
    </div>
  )
}
