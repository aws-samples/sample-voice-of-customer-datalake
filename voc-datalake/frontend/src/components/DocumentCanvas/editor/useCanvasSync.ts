/**
 * The editor <-> Markdown bridge of CanvasEditor: the content serialised after each change (debounced, flushed on
 * blur, on getMarkdown and on unmount), onChange only when the Markdown really changed, and the outline.
 */
import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useRef } from 'react'
import { docToMarkdown, markdownToDoc } from '../markdown/convert'
import { headingsOf } from './headingIds'
import type { OutlineItem } from './CanvasEditor'

const DEBOUNCE_MS = 150

const outlineLevel = (level: number): OutlineItem['level'] | null =>
  level === 1 || level === 2 || level === 3 ? level : null

function outlineOf(editor: Editor): OutlineItem[] {
  return headingsOf(editor.state.doc).flatMap(({ id, level, text }) => {
    const outline = outlineLevel(level)
    return outline ? [{ id, level: outline, text }] : []
  })
}

interface SyncOptions {
  readonly markdown: string
  readonly onChange?: (markdown: string) => void
  readonly onOutlineChange?: (items: readonly OutlineItem[]) => void
}

export function useCanvasSync(editor: Editor | null, { markdown, onChange, onOutlineChange }: SyncOptions) {
  /** The stored text the content came from (untouched blocks are written back from it byte for byte). */
  const stored = useRef(markdown)
  /** The Markdown the host last saw (the stored text, or the last onChange). */
  const emitted = useRef(markdown)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outline = useRef('')
  const callbacks = useRef({ onChange, onOutlineChange })
  useEffect(() => {
    callbacks.current = { onChange, onOutlineChange }
  })

  const publishOutline = useCallback((current: Editor) => {
    const items = outlineOf(current)
    const key = JSON.stringify(items)
    if (key === outline.current) return
    outline.current = key
    callbacks.current.onOutlineChange?.(items)
  }, [])

  const flush = useCallback((): string => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    if (!editor || editor.isDestroyed) return emitted.current
    const next = docToMarkdown(editor.getJSON(), stored.current)
    if (next !== emitted.current) {
      emitted.current = next
      callbacks.current.onChange?.(next)
    }
    return next
  }, [editor])

  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, DEBOUNCE_MS)
  }, [flush])

  const replace = useCallback((next: string) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    stored.current = next
    emitted.current = next
    if (!editor || editor.isDestroyed) return
    editor.chain().setMeta('addToHistory', false).setContent(markdownToDoc(next), { emitUpdate: false }).run()
    publishOutline(editor)
  }, [editor, publishOutline])

  useEffect(() => {
    const onUpdate = () => {
      schedule()
      if (editor) publishOutline(editor)
    }
    if (editor) publishOutline(editor)
    editor?.on('update', onUpdate)
    editor?.on('blur', flush)
    return () => {
      editor?.off('update', onUpdate)
      editor?.off('blur', flush)
      flush()
    }
  }, [editor, flush, schedule, publishOutline])

  // A new `markdown` from the host: the saved text (nothing to do), or other content while nothing is unsaved.
  // Unsaved is judged on the editor's text now (flushed), so a change typed inside the pause is never replaced.
  useEffect(() => {
    if (markdown === emitted.current) {
      stored.current = markdown
      return
    }
    if (flush() === stored.current) replace(markdown)
  }, [markdown, flush, replace])

  return { flush, replace }
}
