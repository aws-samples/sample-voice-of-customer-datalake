/**
 * The document canvas: the ONE editor every view of a document uses (its props and handle below). Markdown in,
 * Markdown out (markdown/convert.ts), edit in place when `editable`, a selectable read-only canvas otherwise. "/" opens the block menu, a selection
 * the format bar, Mod+K the link editor, the grip (or Alt+Shift+M) the block menu.
 *
 * `markdown` is the stored text. When it changes while nothing is unsaved the canvas shows the new text; the
 * saved text coming back after a save changes nothing; to replace unsaved work (load the latest, discard) use
 * the handle's setMarkdown.
 */
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import clsx from 'clsx'
import { lazy, Suspense, useEffect, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { noCleanup } from '../../../hooks/noCleanup'
import type { CalloutKind } from '../markdown/callout'
import { markdownToDoc } from '../markdown/convert'
import { canvasExtensions } from '../markdown/extensions'
import { CanvasController, CanvasKeys } from './controller'
import { HeadingIds, headingsOf } from './headingIds'
import { orNothing } from './orNothing'
import { useCanvasSync } from './useCanvasSync'
import './CanvasEditor.css'

/**
 * The menus, the format bar and the popovers: a chunk of their own (with their libraries), asked for as soon as
 * this module runs, so it loads while the editor starts and the text is never kept waiting for it.
 */
const chrome = orNothing(() => import('./CanvasChrome'))
const CanvasChrome = lazy(() => chrome)

/** A heading of the page's "Contents": h1-h3 (a contents list of every h4 is a second copy of the text). */
export interface OutlineItem { readonly id: string; readonly level: 1 | 2 | 3; readonly text: string }
export interface CanvasEditorHandle {
  /** The editable DOM (ProseMirror view.dom); comment anchors (components/DocumentComments/anchors.ts) index it. */
  readonly root: () => HTMLElement | null
  readonly getMarkdown: () => string
  /** Replace the content (load the latest version, discard) without firing onChange. */
  readonly setMarkdown: (markdown: string) => void
  readonly scrollToHeading: (id: string) => void
  /** Focus the text at its caret; it scrolls the caret into view unless `scroll` is false (the host keeps the page). */
  readonly focus: (options?: { readonly scroll?: boolean }) => void
  /** Collapse the selection to its end without moving focus (a comment took it): the format bar closes. */
  readonly clearSelection: () => void
}
export interface CanvasEditorProps {
  readonly markdown: string
  readonly editable: boolean
  readonly ariaLabel: string
  readonly onChange?: (markdown: string) => void
  readonly onOutlineChange?: (items: readonly OutlineItem[]) => void
  readonly onCommentSelection?: () => void
  readonly handleRef?: React.Ref<CanvasEditorHandle>
  readonly className?: string
}

const EMPTY_CLASS = 'canvas-empty'

const editorDom = (editor: Editor | null) => (editor && !editor.isDestroyed ? editor.view.dom : null)

/**
 * Bring a heading into view (smoothly unless the reader asked for reduced motion) and move there: the caret to the
 * heading's start in an editable canvas, focus to the heading itself (tabindex -1) in a read-only one.
 */
function scrollToHeading(editor: Editor | null, id: string) {
  const target = editorDom(editor)?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  const heading = editor ? headingsOf(editor.state.doc).find((item) => item.id === id) : undefined
  if (!editor || !target || !heading) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  if (editor.isEditable) {
    editor.chain().setTextSelection(heading.pos + 1).focus(undefined, { scrollIntoView: false }).run()
    return
  }
  target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

/**
 * Focus the text at its caret. Without scrolling, the text takes the focus first with preventScroll: TipTap's focus
 * command on iOS and Android calls the DOM's focus() without it (the browser scrolls to the box); focused already,
 * the command leaves the focus and the caret as they are.
 */
function focusText(editor: Editor | null, scroll: boolean) {
  if (!editor || editor.isDestroyed) return
  if (!scroll) editor.view.dom.focus({ preventScroll: true })
  editor.chain().focus(undefined, { scrollIntoView: scroll }).run()
}

/** The schema and keys, built once per canvas (a language switch shows in the next canvas, the content is kept). */
function useExtensions(controller: CanvasController) {
  const { t } = useTranslation('projectDetail')
  const [extensions] = useState(() => {
    const calloutLabels: Record<CalloutKind, string> = {
      note: t('canvas.editor.callout.note'),
      tip: t('canvas.editor.callout.tip'),
      important: t('canvas.editor.callout.important'),
      warning: t('canvas.editor.callout.warning'),
      caution: t('canvas.editor.callout.caution'),
    }
    return [
      ...canvasExtensions({ placeholder: t('canvas.editor.placeholder'), calloutLabels, taskLabel: () => t('canvas.editor.task'), emptyClass: EMPTY_CLASS }),
      HeadingIds,
      CanvasKeys.configure({ controller: () => controller }),
    ]
  })
  return extensions
}

export default function CanvasEditor({
  markdown, editable, ariaLabel, onChange, onOutlineChange, onCommentSelection, handleRef, className,
}: CanvasEditorProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [controller] = useState(() => new CanvasController())
  const extensions = useExtensions(controller)
  const [content] = useState(() => markdownToDoc(markdown))
  // Created once; on later renders useEditor hands these options to the editor (the aria-label stays current).
  const editor = useEditor({
    extensions,
    content,
    editable,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { 'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true', class: 'canvas-editor__content' } },
  })
  const { flush, replace } = useCanvasSync(editor, { markdown, onChange, onOutlineChange })

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editor, editable])

  // Where the pointer is over the canvas, for the block handle that loads after the text (BlockHandle.tsx).
  useEffect(() => {
    if (!container) return noCleanup
    const move = (event: MouseEvent) => controller.setPointer({ x: event.clientX, y: event.clientY, buttons: event.buttons })
    const leave = () => controller.setPointer(null)
    container.addEventListener('mousemove', move, { passive: true })
    container.addEventListener('mouseleave', leave)
    return () => {
      container.removeEventListener('mousemove', move)
      container.removeEventListener('mouseleave', leave)
    }
  }, [container, controller])

  useImperativeHandle(handleRef, () => ({
    root: () => editorDom(editor),
    getMarkdown: flush,
    setMarkdown: replace,
    scrollToHeading: (id) => scrollToHeading(editor, id),
    focus: (options) => focusText(editor, options?.scroll ?? true),
    clearSelection: () => {
      if (editor && !editor.isDestroyed && !editor.state.selection.empty) editor.commands.setTextSelection(editor.state.selection.to)
    },
  }), [editor, flush, replace])

  return (
    <div ref={setContainer} className={clsx('canvas-editor', className)} data-editable={editable}>
      <EditorContent editor={editor} />
      {editor && (
        <Suspense fallback={null}>
          <CanvasChrome editor={editor} editable={editable} container={container} controller={controller} onComment={onCommentSelection} />
        </Suspense>
      )}
    </div>
  )
}
