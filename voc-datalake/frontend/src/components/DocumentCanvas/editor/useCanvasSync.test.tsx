/**
 * useCanvasSync on a save: the saved text comes back as `markdown`, and the next change is matched against it, so it
 * is indexed when the page is next idle instead of on that change's keystroke (a long document's parse takes long).
 */
import type { Editor } from '@tiptap/core'
import { act, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as convert from '../markdown/convert'
import CanvasEditor, { type CanvasEditorHandle } from './CanvasEditor'

vi.mock('../markdown/convert', async (importOriginal) => {
  const original = await importOriginal<typeof convert>()
  return { ...original, prepareStored: vi.fn(original.prepareStored) }
})

const isEditor = (value: unknown): value is Editor =>
  typeof value === 'object' && value !== null && 'commands' in value && 'state' in value

function renderCanvas(markdown: string) {
  const handle = createRef<CanvasEditorHandle>()
  const onChange = vi.fn<(next: string) => void>()
  const view = render(<CanvasEditor markdown={markdown} editable ariaLabel="Plan" onChange={onChange} handleRef={handle} />)
  const rerender = (next: string) => view.rerender(<CanvasEditor markdown={next} editable ariaLabel="Plan" onChange={onChange} handleRef={handle} />)
  return { handle, onChange, rerender }
}

async function editorOf(handle: React.RefObject<CanvasEditorHandle | null>): Promise<Editor> {
  const root = await waitFor(() => handle.current?.root() ?? Promise.reject(new Error('not mounted yet')))
  const editor: unknown = Reflect.get(root, 'editor')
  if (!isEditor(editor)) throw new Error('no editor on the DOM')
  return editor
}

/** Types `text` at the end of the canvas and returns what a save of it would store. */
function typeAtEnd(editor: Editor, handle: React.RefObject<CanvasEditorHandle | null>, text: string): string {
  act(() => {
    editor.chain().setTextSelection(editor.state.doc.content.size - 1).insertContent(text).run()
  })
  return handle.current?.getMarkdown() ?? ''
}

describe('useCanvasSync after a save', () => {
  it('indexes the saved text when the page is idle, once, and not the text it opened with', async () => {
    const { handle, onChange, rerender } = renderCanvas('# Plan\n\nFirst.')
    const saved = typeAtEnd(await editorOf(handle), handle, ' More.')
    expect(onChange).toHaveBeenLastCalledWith('# Plan\n\nFirst. More.')
    expect(vi.mocked(convert.prepareStored)).not.toHaveBeenCalled()

    // The host saved it: the saved text comes back as the stored one.
    rerender(saved)

    await waitFor(() => expect(vi.mocked(convert.prepareStored)).toHaveBeenCalledWith(saved))
    rerender(saved)
    expect(vi.mocked(convert.prepareStored)).toHaveBeenCalledTimes(1)
  })

  it('waits for the browser\'s idle callback, and cancels it when the stored text moves on first', async () => {
    vi.mocked(convert.prepareStored).mockClear()
    const idle = vi.fn<(task: IdleRequestCallback, options?: IdleRequestOptions) => number>(() => 7)
    const cancel = vi.fn<(handle: number) => void>()
    vi.stubGlobal('requestIdleCallback', idle)
    vi.stubGlobal('cancelIdleCallback', cancel)
    try {
      const { handle, rerender } = renderCanvas('# Plan\n\nFirst.')
      const editor = await editorOf(handle)
      rerender(typeAtEnd(editor, handle, ' More.'))
      expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 })

      rerender(typeAtEnd(editor, handle, ' Again.'))

      expect(cancel).toHaveBeenCalledWith(7)
      act(() => idle.mock.calls[1]?.[0]({ didTimeout: false, timeRemaining: () => 50 }))
      expect(vi.mocked(convert.prepareStored)).toHaveBeenCalledWith('# Plan\n\nFirst. More. Again.')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
