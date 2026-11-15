/**
 * @fileoverview A PR/FAQ or PRD rendered as plain Markdown with its comment threads: the review
 * page (`/review/:shareId`) reads the document this way (docs/document-review.md -> Comments).
 *
 * The rail, bubbles, highlights and filters are `CommentedDocument`'s; this view adds the
 * Markdown and its floating "Comment" button: select text and press it, and the thread is
 * anchored by that quote. (The project's canvas has its own Comment button in the editor's
 * floating bar; see pages/ProjectDetail/DocumentReviewView.)
 *
 * @module components/DocumentComments/DocumentComments
 */
import { MessageSquarePlus } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CommentedDocument from './CommentedDocument'
import { useSelectionAnchor } from './useSelectionAnchor'
import { READING_TEXT_CLASS } from '../DocumentCanvas/comments/readingColumn'
import type { CommentedDocumentHandle } from './CommentedDocument'
import type { CommentActions, ViewedVersion } from './commentTypes'
import type { CommentThread } from '../../api/documentReviewSchema'

interface DocumentCommentsProps {
  /** The markdown, already prepared for display. */
  readonly markdown: string
  readonly threads: readonly CommentThread[]
  readonly viewed: ViewedVersion
  readonly actions: CommentActions
  readonly canComment: boolean
}

export default function DocumentComments({ markdown, threads, viewed, actions, canComment }: DocumentCommentsProps) {
  const { t } = useTranslation('components')
  const rootRef = useRef<HTMLDivElement>(null)
  const commentRef = useRef<CommentedDocumentHandle>(null)
  const contentRoot = useCallback(() => rootRef.current, [])
  const { selected, clear } = useSelectionAnchor(rootRef, canComment)
  return (
    <CommentedDocument contentRoot={contentRoot} revision={markdown} threads={threads} viewed={viewed}
      actions={actions} canComment={canComment} commentRef={commentRef}>
      <div ref={rootRef} className={READING_TEXT_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
      {selected === null ? null : (
        <button type="button" className="btn btn-primary btn-sm absolute z-20 shadow-md"
          style={{ top: selected.top, left: selected.left }}
          // Keep the selection: a mousedown on the button would collapse it first.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { commentRef.current?.commentOnSelection(); clear() }}>
          <MessageSquarePlus size={14} aria-hidden />{t('documentComments.comment')}
        </button>
      )}
    </CommentedDocument>
  )
}
