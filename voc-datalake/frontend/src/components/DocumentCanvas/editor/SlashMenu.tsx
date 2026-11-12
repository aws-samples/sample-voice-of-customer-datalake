/**
 * The "/" block menu: a listbox the caret drives (the combobox pattern: the editor keeps focus and points at the
 * active option with aria-activedescendant). Type to filter, arrows to move, Enter or Tab to insert, Esc to close.
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MENU_KEYS, rovingIndex } from '../../../utils/rovingIndex'
import { applyBlock, type BlockChoice, SLASH_BLOCKS } from './blocks'
import type { CanvasController } from './controller'
import { anchorAt } from './floating'
import { filterBlocks, sameTrigger, slashTrigger } from './slashTrigger'

interface SlashMenuProps {
  readonly editor: Editor
  readonly container: HTMLElement | null
  readonly controller: CanvasController
  /** Image was chosen: the "/" is gone, the host opens the image dialog at the caret. */
  readonly onImage: () => void
}

const ARIA = ['aria-expanded', 'aria-controls', 'aria-activedescendant', 'aria-autocomplete'] as const

function useAriaOnEditor(editor: Editor, listId: string, activeId: string | null) {
  useEffect(() => {
    const dom = editor.view.dom
    if (activeId !== null) {
      dom.setAttribute('aria-expanded', 'true')
      dom.setAttribute('aria-controls', listId)
      dom.setAttribute('aria-autocomplete', 'list')
      if (activeId === '') dom.removeAttribute('aria-activedescendant')
      else dom.setAttribute('aria-activedescendant', activeId)
    }
    return () => ARIA.forEach((name) => dom.removeAttribute(name))
  }, [editor, listId, activeId])
}

interface KeyContext {
  readonly items: readonly BlockChoice[]
  readonly index: number
  readonly move: (index: number) => void
  readonly choose: (block: BlockChoice) => void
  readonly dismiss: () => void
}

function handleKey(event: KeyboardEvent, { items, index, move, choose, dismiss }: KeyContext): boolean {
  if (event.key === 'Escape') {
    dismiss()
    return true
  }
  const count = items.length
  if (count === 0) return false
  // The arrows only: Home and End stay the caret's in the text the menu filters on.
  const next = event.key === 'ArrowDown' || event.key === 'ArrowUp' ? rovingIndex(event.key, index, count, MENU_KEYS) : null
  if (next !== null) {
    move(next)
    return true
  }
  const item = items[index]
  if ((event.key === 'Enter' || event.key === 'Tab') && item) {
    choose(item)
    return true
  }
  return false
}

export default function SlashMenu({ editor, container, controller, onImage }: SlashMenuProps) {
  const { t } = useTranslation('projectDetail')
  const listId = useId()
  const trigger = useEditorState({ editor, selector: ({ editor: current }) => (current.isEditable ? slashTrigger(current.state) : null), equalityFn: sameTrigger })
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [cursor, setCursor] = useState({ query: '', index: 0 })
  const label = (block: BlockChoice) => t(`canvas.editor.blocks.${block.id}`)
  const open = trigger !== null && trigger.from !== dismissedAt ? trigger : null
  const items = open ? filterBlocks(SLASH_BLOCKS, open.query, label) : []
  const index = open?.query === cursor.query ? Math.min(cursor.index, Math.max(items.length - 1, 0)) : 0
  const active = open ? items[index] : undefined
  const activeId = active ? `${listId}-${active.id}` : null

  const choose = (block: BlockChoice) => {
    if (!open) return
    const range = { from: open.from, to: open.to }
    if (block.id === 'image') {
      // No focus(): TipTap focuses on the next frame, which would take the focus back from the dialog's field.
      editor.chain().deleteRange(range).run()
      onImage()
      return
    }
    applyBlock(editor.chain().focus().deleteRange(range), block.id).run()
  }

  useAriaOnEditor(editor, listId, open ? activeId ?? '' : null)

  useEffect(() => {
    if (open) controller.setSlashKeyDown((event) => handleKey(event, {
      items,
      index,
      move: (next) => setCursor({ query: open.query, index: next }),
      choose,
      dismiss: () => setDismissedAt(open.from),
    }))
    return () => controller.setSlashKeyDown(null)
  })

  if (!open) return null
  const anchor = anchorAt(editor, open.from, container)
  return (
    <div id={listId} role="listbox" aria-label={t('canvas.editor.slash.label')} className="canvas-menu canvas-menu--floating" style={{ top: anchor.top, left: anchor.left }}>
      {items.length === 0 && <p role="status" className="canvas-menu__empty">{t('canvas.editor.slash.empty', { query: open.query })}</p>}
      {items.map((block, at) => {
        const Icon = block.icon
        return (
          <div
            key={block.id}
            id={`${listId}-${block.id}`}
            role="option"
            aria-selected={at === index}
            className="canvas-menu__item"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setCursor({ query: open.query, index: at })}
            onClick={() => choose(block)}
          >
            <Icon aria-hidden="true" className="canvas-menu__icon" />
            <span>{label(block)}</span>
          </div>
        )
      })}
    </div>
  )
}
