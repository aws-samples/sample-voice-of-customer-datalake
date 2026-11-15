/**
 * The floating format bar on a text selection: Bold, Italic, Strike, Code, Link, Turn into, and Comment when the
 * host takes comments (in a read-only canvas, Comment alone). A toolbar: one tab stop, arrows move between the
 * buttons, Esc hides it until the selection changes; Alt+F10 in the text moves focus to it.
 */
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, ChevronDown, Code, Italic, Link, type LucideIcon, MessageSquarePlus, Strikethrough } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rovingIndex, TAB_KEYS } from '../../../utils/rovingIndex'
import { TURN_INTO_BLOCKS, turnInto } from './blocks'
import type { CanvasController } from './controller'
import MenuList from './MenuList'

interface FormatBarProps {
  readonly editor: Editor
  readonly controller: CanvasController
  readonly onComment?: () => void
}

interface MarkButton { readonly mark: 'bold' | 'italic' | 'strike' | 'code'; readonly icon: LucideIcon }

const MARKS: readonly MarkButton[] = [
  { mark: 'bold', icon: Bold },
  { mark: 'italic', icon: Italic },
  { mark: 'strike', icon: Strikethrough },
  { mark: 'code', icon: Code },
]

function toggleMark(editor: Editor, mark: MarkButton['mark']) {
  const chain = editor.chain().focus()
  switch (mark) {
    case 'bold': return chain.toggleBold().run()
    case 'italic': return chain.toggleItalic().run()
    case 'strike': return chain.toggleStrike().run()
    case 'code': return chain.toggleCode().run()
  }
}

function rove(event: KeyboardEvent<HTMLDivElement>, bar: HTMLDivElement | null) {
  const buttons = [...(bar?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? [])]
  if (buttons.length === 0) return
  const index = Math.max(buttons.findIndex((button) => button === document.activeElement), 0)
  const next = rovingIndex(event.key, index, buttons.length, TAB_KEYS)
  if (next === null) return
  event.preventDefault()
  buttons[next]?.focus()
}

/** A selection with some text in it (not a selected image or raw block). */
const hasTextSelection = (editor: Editor) => {
  const { selection, doc } = editor.state
  return !selection.empty && !(selection instanceof NodeSelection) && doc.textBetween(selection.from, selection.to, ' ').trim() !== ''
}

export default function FormatBar({ editor, controller, onComment }: FormatBarProps) {
  const { t } = useTranslation('projectDetail')
  const bar = useRef<HTMLDivElement>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [turnIntoOpen, setTurnIntoOpen] = useState(false)
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      editable: current.isEditable,
      selection: `${current.state.selection.from}:${current.state.selection.to}`,
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
    }),
  })
  // The bubble menu's plugin keeps the first shouldShow it is given: it reads the live values through a ref.
  const show = useRef({ visible: true, commentable: false })
  show.current = { visible: dismissed !== state.selection, commentable: onComment !== undefined }

  useEffect(() => {
    controller.setFocusToolbar(() => bar.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus())
    return () => controller.setFocusToolbar(null)
  }, [controller])

  const close = () => {
    setTurnIntoOpen(false)
    setDismissed(state.selection)
    show.current = { ...show.current, visible: false }
    editor.commands.focus()
    // An empty transaction makes the bubble menu ask shouldShow again, so it hides now.
    editor.view.dispatch(editor.state.tr)
  }

  const button = (key: string, label: string, Icon: LucideIcon, onClick: () => void, pressed?: boolean) => (
    <button key={key} type="button" className="canvas-bar__button" aria-label={label} title={label} aria-pressed={pressed} tabIndex={-1} onClick={onClick}>
      <Icon aria-hidden="true" className="canvas-bar__icon" />
    </button>
  )

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={() => show.current.visible && hasTextSelection(editor) && (editor.isEditable || show.current.commentable)}
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 } }}
    >
      <div
        ref={bar}
        role="toolbar"
        aria-label={t('canvas.editor.format.toolbar')}
        className="canvas-bar"
        onFocus={(event) => {
          if (event.target === bar.current) bar.current.querySelector<HTMLButtonElement>(':scope > button')?.focus()
        }}
        tabIndex={0}
        // A click on a button must not move focus or the selection out of the text (Comment reads the selection).
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
            return
          }
          rove(event, bar.current)
        }}
      >
        {state.editable && MARKS.map(({ mark, icon }) => button(mark, t(`canvas.editor.format.${mark}`), icon, () => toggleMark(editor, mark), state[mark]))}
        {state.editable && button('link', t('canvas.editor.format.link'), Link, () => controller.openLink(), state.link)}
        {state.editable && (
          <button type="button" className="canvas-bar__button canvas-bar__button--text" aria-haspopup="menu" aria-expanded={turnIntoOpen} tabIndex={-1} onClick={() => setTurnIntoOpen((open) => !open)}>
            <span>{t('canvas.editor.format.turnInto')}</span>
            <ChevronDown aria-hidden="true" className="canvas-bar__icon" />
          </button>
        )}
        {onComment && (
          <button type="button" className="canvas-bar__button canvas-bar__button--text" tabIndex={-1} onClick={() => onComment()}>
            <MessageSquarePlus aria-hidden="true" className="canvas-bar__icon" />
            <span>{t('canvas.editor.format.comment')}</span>
          </button>
        )}
      </div>
      {turnIntoOpen && (
        <MenuList
          label={t('canvas.editor.format.turnInto')}
          className="canvas-menu canvas-menu--attached"
          onClose={() => setTurnIntoOpen(false)}
          items={TURN_INTO_BLOCKS.map((block) => ({
            id: block.id,
            label: t(`canvas.editor.blocks.${block.id}`),
            icon: block.icon,
            onSelect: () => {
              setTurnIntoOpen(false)
              turnInto(editor, block.id)
            },
          }))}
        />
      )}
    </BubbleMenu>
  )
}
