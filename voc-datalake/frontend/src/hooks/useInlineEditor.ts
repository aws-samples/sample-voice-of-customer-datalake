/**
 * @fileoverview Keyboard behaviour of an editor that opens in place of its trigger button
 * ("Change category", "Edit tags"): opening moves focus to the editor's first field, Escape
 * cancels, and closing (cancel, Escape or a save) returns focus to the trigger — the
 * dialog rule of the design system, for an inline editor.
 * @module hooks/useInlineEditor
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

const FOCUSABLE = 'select, input, textarea, button, [tabindex]:not([tabindex="-1"])'

/**
 * Focus the editor's first field. While its fields are still loading the container itself
 * (tabIndex -1) holds focus, and the first field takes it as soon as it appears — unless the
 * reader has moved focus elsewhere meanwhile. Returns the cleanup for the wait.
 */
function focusFirstField(editor: HTMLElement | null): (() => void) | undefined {
  if (editor === null) return undefined
  const field = editor.querySelector<HTMLElement>(FOCUSABLE)
  if (field !== null) {
    field.focus()
    return undefined
  }
  editor.focus()
  const observer = new MutationObserver(() => {
    const next = editor.querySelector<HTMLElement>(FOCUSABLE)
    if (next === null) return
    observer.disconnect()
    if (document.activeElement === editor) next.focus()
  })
  observer.observe(editor, { childList: true, subtree: true })
  return () => observer.disconnect()
}

export interface InlineEditor {
  readonly open: boolean
  readonly openEditor: () => void
  readonly close: () => void
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly editorRef: RefObject<HTMLDivElement | null>
  /** On the editor's container: Escape cancels (and stops there, so an enclosing dialog stays open). */
  readonly onKeyDown: (event: KeyboardEvent) => void
}

export function useInlineEditor(): InlineEditor {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef(false)

  useEffect(() => {
    if (open) return focusFirstField(editorRef.current)
    if (returnFocus.current) {
      returnFocus.current = false
      triggerRef.current?.focus()
    }
    return undefined
  }, [open])

  const close = useCallback(() => {
    returnFocus.current = true
    setOpen(false)
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
  }, [close])

  const openEditor = useCallback(() => setOpen(true), [])

  return { open, openEditor, close, triggerRef, editorRef, onKeyDown }
}
