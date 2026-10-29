/**
 * @fileoverview What a comment view can do, given by its host: the project's document view
 * (the team: every action) or the review page (a reviewer: comment and reply only).
 *
 * @module components/DocumentComments/commentTypes
 */
import type { NewComment } from '../../api/documentReviewApi'
import type { CommentThread } from '../../api/documentReviewSchema'

export interface CommentActions {
  readonly create: (comment: NewComment) => Promise<unknown>
  readonly reply: (commentId: string, text: string) => Promise<unknown>
  /** Absent = the caller cannot resolve / reopen (a reviewer). */
  readonly resolve?: (commentId: string) => Promise<unknown>
  readonly reopen?: (commentId: string) => Promise<unknown>
  readonly remove?: (commentId: string) => Promise<unknown>
  /** May this caller delete this thread (its author, or a project editor)? */
  readonly canRemove?: (thread: CommentThread) => boolean
}

/** The version the reader is looking at (a thread made on another one says so). */
export interface ViewedVersion {
  readonly documentId: string
}
