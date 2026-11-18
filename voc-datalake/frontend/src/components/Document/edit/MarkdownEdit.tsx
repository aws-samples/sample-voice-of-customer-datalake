/**
 * @fileoverview The edit engine, loaded only when a surface edits: the canvas (edit/editor/CanvasEditor, TipTap) as a
 * chunk of its own, asked for with `import()` on Edit. Until it arrives the text shows as it reads (the light reader),
 * never a blank box. A page that is itself lazy-loaded with the editor (the Projects Documents tab) renders the canvas
 * directly instead.
 *
 * @module components/Document/edit/MarkdownEdit
 */
import { lazy, Suspense } from 'react'
import MarkdownRead from '../read/MarkdownRead'
import { markdownPolicy } from '../read/markdownPolicy'
import type { CanvasEditorProps } from './editor/CanvasEditor'

const CanvasEditor = lazy(() => import('./editor/CanvasEditor'))

/** The canvas editor's props a field editor takes: no outline, comment selection or focus on mount here. */
type MarkdownEditProps = Omit<CanvasEditorProps, 'autoFocus' | 'onCommentSelection' | 'onOutlineChange'>

export default function MarkdownEdit(props: MarkdownEditProps) {
  return (
    <Suspense fallback={<MarkdownRead source={props.markdown} policy={markdownPolicy.stored} className={props.className} headingIds={false} />}>
      <CanvasEditor {...props} />
    </Suspense>
  )
}
