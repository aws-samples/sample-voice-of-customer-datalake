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

function renderHandle() {
  const editor = headlessEditor('One\n\nTwo')
  const block = editor.state.doc.child(0)
  const onOpenMenu = vi.fn<(pos: number) => void>()
  render(<BlockHandle editor={editor} onOpenMenu={onOpenMenu} />)
  const grip = screen.getByRole('button', { name: 'Drag to move the block, or click for its menu' })
  const hover = (pos: number | null) => act(() => handle.report?.({ node: pos === null ? null : block, editor, pos: pos ?? -1 }))
  return { editor, onOpenMenu, grip, hover }
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
})
