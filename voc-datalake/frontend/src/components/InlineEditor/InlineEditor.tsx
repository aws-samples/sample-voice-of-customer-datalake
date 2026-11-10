/**
 * @fileoverview A trigger button that opens an editor in its place ("Change category",
 * "Edit tags"), with the dialog keyboard rules of the design system: focus moves into the
 * editor, Escape cancels, and focus returns to the trigger when it closes (`useInlineEditor`).
 * @module components/InlineEditor
 */
import type { ReactNode } from 'react'
import { useInlineEditor } from '../../hooks/useInlineEditor'

interface InlineEditorProps {
  /** The trigger's content (icon + label). */
  readonly trigger: ReactNode
  /** The editor; call `close` to cancel or after a save. */
  readonly children: (close: () => void) => ReactNode
}

export default function InlineEditor({ trigger, children }: InlineEditorProps) {
  const { open, openEditor, close, triggerRef, editorRef, onKeyDown } = useInlineEditor()
  if (open) {
    return (
      <div ref={editorRef} tabIndex={-1} onKeyDown={onKeyDown} className="w-full focus:outline-none">
        {children(close)}
      </div>
    )
  }
  return (
    <button ref={triggerRef} type="button" onClick={openEditor} className="btn btn-ghost btn-sm">
      {trigger}
    </button>
  )
}
