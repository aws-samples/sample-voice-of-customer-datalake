/**
 * @fileoverview A stand-in for the canvas editor in page specs: a textarea named by the
 * document's title, with the editor's handle (setMarkdown replaces the text without firing
 * onChange, as the real one does). Use it from a `vi.mock` factory:
 * `vi.mock('…/editor/CanvasEditor', async () => ({ default: (await import('…/canvas-editor-fixtures')).FakeCanvasEditor }))`.
 */
import { useImperativeHandle, useRef, useState } from 'react'
import type { CanvasEditorProps } from '../editor/CanvasEditor'

export function FakeCanvasEditor({ markdown, editable, ariaLabel, onChange, handleRef }: CanvasEditorProps) {
  const [value, setValue] = useState(markdown)
  const current = useRef(markdown)
  const root = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(handleRef, () => ({
    root: () => root.current,
    getMarkdown: () => current.current,
    setMarkdown: (next: string) => { current.current = next; setValue(next) },
    scrollToHeading: () => { /* a textarea has no headings */ },
    focus: () => root.current?.focus(),
    clearSelection: () => { root.current?.setSelectionRange(root.current.selectionEnd, root.current.selectionEnd) },
  }), [])
  return (
    <textarea ref={root} aria-label={ariaLabel} readOnly={!editable} value={value}
      onChange={(event) => { current.current = event.target.value; setValue(event.target.value); onChange?.(event.target.value) }} />
  )
}
