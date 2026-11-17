/**
 * @fileoverview A PR/FAQ or PRD read through the shared light reader (callouts, to-dos and heading ids as on the
 * canvas, the stored-text link policy) with its comment threads: the review
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
import CommentedDocument from './CommentedDocument'
import MarkdownRead from '../Document/read/MarkdownRead'
import { markdownPolicy } from '../Document/read/markdownPolicy'
import { useSelectionAnchor } from './useSelectionAnchor'
import { READING_TEXT_CLASS } from '../Document/readingColumn'
import type { CommentedDocumentHandle } from './CommentedDocument'
import type { CommentActions, ViewedVersion } from './commentTypes'
import type { CommentThread } from '../../api/documentReviewSchema'
import type { OutlineItem } from '../Document/types'

interface DocumentCommentsProps {
  /** The markdown, already prepared for display. */
  readonly markdown: string
  readonly threads: readonly CommentThread[]
  readonly viewed: ViewedVersion
  readonly actions: CommentActions
  readonly canComment: boolean
  /** The text's h1–h3, after each parse (the surface's Contents). */
  readonly onOutline: (items: readonly OutlineItem[]) => void
}

export default function DocumentComments({ markdown, threads, viewed, actions, canComment, onOutline }: DocumentCommentsProps) {
  const { t } = useTranslation('components')
  const rootRef = useRef<HTMLDivElement>(null)
  const commentRef = useRef<CommentedDocumentHandle>(null)
  const contentRoot = useCallback(() => rootRef.current, [])
  const { selected, clear } = useSelectionAnchor(rootRef, canComment)
  return (
    <CommentedDocument contentRoot={contentRoot} revision={markdown} threads={threads} viewed={viewed}
      actions={actions} canComment={canComment} commentRef={commentRef}>
      <MarkdownRead source={markdown} policy={markdownPolicy.stored} className={READING_TEXT_CLASS} rootRef={rootRef}
        onOutline={onOutline} />
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
