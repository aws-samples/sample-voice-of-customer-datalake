/**
 * The grip's own logic: which block its menu opens for. The drag handle plugin reports the block under the pointer
 * through onNodeChange; jsdom has no layout to hover, so a stand-in reports it here (the real handle, on the
 * canvas's Yjs stand-in, is mounted in CanvasEditor.test.tsx).
 */
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import BlockHandle from './BlockHandle'
import type { Pointer } from './controller'
import { headlessEditor } from './headless-editor-fixtures'

type NodeChange = (data: { node: PMNode | null; editor: Editor; pos: number }) => void
const handle: { report?: NodeChange; props?: Record<string, unknown> } = {}

vi.mock('@tiptap/extension-drag-handle-react', () => ({
  DragHandle: ({ children, onNodeChange, ...props }: { children: ReactNode; onNodeChange: NodeChange }) => {
    handle.report = onNodeChange
    handle.props = props
    return <div data-testid="drag-handle">{children}</div>
  },
}))

function renderHandle(pointer: Pointer | null = null) {
  const editor = headlessEditor('One\n\nTwo')
  const block = editor.state.doc.child(0)
  const onOpenMenu = vi.fn<(pos: number) => void>()
  const moves: Pointer[] = []
  editor.view.dom.addEventListener('mousemove', (event) => moves.push({ x: event.clientX, y: event.clientY, buttons: event.buttons }))
  render(<BlockHandle editor={editor} onOpenMenu={onOpenMenu} lastPointer={() => pointer} />)
  const grip = screen.getByRole('button', { name: 'Drag to move the block, or click for its menu' })
  const hover = (pos: number | null) => act(() => handle.report?.({ node: pos === null ? null : block, editor, pos: pos ?? -1 }))
  return { editor, onOpenMenu, grip, hover, moves }
}

describe('BlockHandle', () => {
  it('is a labelled grip on the editor that says it opens a menu and names its shortcut', () => {
    const { editor, grip } = renderHandle()
    expect(grip).toHaveAttribute('aria-haspopup', 'menu')
    expect(grip).toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+M')
    expect(handle.props).toMatchObject({ editor, className: 'canvas-handle' })
  })

  it('opens the menu for the block last under the pointer', () => {
    const { onOpenMenu, grip, hover } = renderHandle()
    hover(7)
    hover(12)
    fireEvent.click(grip)
    expect(onOpenMenu).toHaveBeenCalledExactlyOnceWith(12)
  })

  it('opens nothing before a block was hovered, or once the pointer left the blocks', () => {
    const { onOpenMenu, grip, hover } = renderHandle()
    fireEvent.click(grip)
    hover(3)
    hover(null)
    fireEvent.click(grip)
    expect(onOpenMenu).not.toHaveBeenCalled()
  })

  it('opens the menu for the first block (position 0)', () => {
    const { onOpenMenu, grip, hover } = renderHandle()
    hover(0)
    fireEvent.click(grip)
    expect(onOpenMenu).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('moves the pointer once on the text where it already was when it loaded, so the grip shows there at once', () => {
    const { moves } = renderHandle({ x: 40, y: 120, buttons: 0 })
    expect(moves).toStrictEqual([{ x: 40, y: 120, buttons: 0 }])
  })

  it.each<[string, Pointer | null]>([
    ['the pointer was not over the text', null],
    ['a mouse button is held (a selection or a drag in progress)', { x: 40, y: 120, buttons: 1 }],
  ])('moves nothing when %s', (_when, pointer) => {
    expect(renderHandle(pointer).moves).toStrictEqual([])
  })
})
