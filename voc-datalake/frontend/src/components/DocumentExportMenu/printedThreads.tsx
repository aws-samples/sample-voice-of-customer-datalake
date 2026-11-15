/**
 * @fileoverview Which comment threads a printed document carries ("Include open comments"): those whose quote its
 * printed text still holds, located as the comments rail locates them on the canvas (components/DocumentComments/
 * anchors.ts), and those on the whole document. A thread whose passage this version no longer has is left out.
 *
 * @module components/DocumentExportMenu/printedThreads
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { anchorFound, indexText } from '../DocumentComments/anchors'
import { DocumentBody } from './DocumentPDFContent'
import type { CommentThread } from '../../api/documentReviewSchema'
import type { ProjectDocument } from '../../api/types'

export function printedThreads(
  doc: Pick<ProjectDocument, 'content'>, threads: readonly CommentThread[],
): readonly CommentThread[] {
  // An inert document: nothing in it loads or runs.
  const printed = new DOMParser().parseFromString(renderToStaticMarkup(<DocumentBody document={doc} />), 'text/html')
  const index = indexText(printed.body)
  return threads.filter((thread) => thread.anchor === null || anchorFound(index, thread.anchor))
}
