/**
 * @fileoverview A stand-in for the canvas editor in page specs: a textarea named by the
 * document's title, with the editor's handle (setMarkdown replaces the text without firing
 * onChange, as the real one does). Use it from a `vi.mock` factory:
 * `vi.mock('…/editor/CanvasEditor', async () => ({ default: (await import('…/canvas-editor-fixtures')).FakeCanvasEditor }))`.
 * FakeReviewView stands in for a PR/FAQ / PRD's comments view (pages/ProjectDetail/DocumentReviewView) the same way:
 * only its canvas, named by the document's title.
 */
import { useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { CanvasEditorProps } from '../../Document/edit/editor/CanvasEditor'
import type { ProjectDocument } from '../../../api/types'

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
    // A textarea has none of the editor's commands.
    run: () => false,
    can: () => false,
  }), [])
  return (
    <textarea ref={root} aria-label={ariaLabel} readOnly={!editable} value={value}
      onChange={(event) => { current.current = event.target.value; setValue(event.target.value); onChange?.(event.target.value) }} />
  )
}

/** The comments view's stand-in: the document's canvas alone (a spec that reads only the canvas). */
export function FakeReviewView({ document, markdown, editable, onChange, handleRef }: Readonly<{
  document: ProjectDocument; markdown: string; editable: boolean
  onChange?: (markdown: string) => void; handleRef?: Ref<never>
}>) {
  return <FakeCanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title} onChange={onChange} handleRef={handleRef} />
}
