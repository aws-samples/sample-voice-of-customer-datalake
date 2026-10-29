/**
 * @fileoverview Document comments, review links, the persona review and the review page
 * (docs/document-review.md).
 *
 * A FACTORY over a transport, like featureRequestsApi: the project's team calls the
 * `/projects/{id}/documents/{doc}/…` routes with the app session (`appDocumentCommentsApi`), a
 * reviewer calls `/review/{share_id}…` with the board pool's session (the review page builds its
 * own over `boardTransport`). The parameter is named `fetchApi` so check-mock-coverage reads the
 * call sites.
 *
 * @module api/documentReviewApi
 */
import { fetchApi as appFetchApi } from './client'
import { runAssistJob } from './assistJobs'
import { projectsApi } from './projectsApi'
import { del, post } from './requestKit'
import {
  parseCommentsAnswer, parsePersonaReviewResult, parseReviewAnswer, parseShareAnswer, parseThreadAnswer,
} from './documentReviewSchema'
import type { FetchApi } from './requestKit'
import type {
  CommentThread, DocumentCommentsAnswer, PersonaReviewResult, ReviewPageAnswer, ReviewShare, ShareAudience,
  TextQuoteAnchor,
} from './documentReviewSchema'

export interface NewComment {
  readonly text: string
  readonly anchor: TextQuoteAnchor | null
}

export interface ShareSettings {
  readonly audience: ShareAudience
  readonly expires_in_days: number
}

const enc = encodeURIComponent

function documentPath(projectId: string, documentId: string): string {
  return `/projects/${enc(projectId)}/documents/${enc(documentId)}`
}

function commentPath(projectId: string, documentId: string, commentId: string): string {
  return `${documentPath(projectId, documentId)}/comments/${enc(commentId)}`
}

function reviewPath(shareId: string): string {
  return `/review/${enc(shareId)}`
}

function commentBody(comment: NewComment): { text: string; anchor?: TextQuoteAnchor } {
  return comment.anchor === null ? { text: comment.text } : { text: comment.text, anchor: comment.anchor }
}

/** The team's calls (app session). */
function createDocumentCommentsApi(fetchApi: FetchApi) {
  return {
    async list(projectId: string, documentId: string): Promise<DocumentCommentsAnswer> {
      return parseCommentsAnswer(await fetchApi<unknown>(`${documentPath(projectId, documentId)}/comments`))
    },
    async create(projectId: string, documentId: string, comment: NewComment): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${documentPath(projectId, documentId)}/comments`, post(commentBody(comment))))
    },
    async reply(projectId: string, documentId: string, commentId: string, text: string): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${commentPath(projectId, documentId, commentId)}/replies`, post({ text })))
    },
    async resolve(projectId: string, documentId: string, commentId: string): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${commentPath(projectId, documentId, commentId)}/resolve`, post()))
    },
    async reopen(projectId: string, documentId: string, commentId: string): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${commentPath(projectId, documentId, commentId)}/reopen`, post()))
    },
    async remove(projectId: string, documentId: string, commentId: string): Promise<void> {
      await fetchApi<unknown>(commentPath(projectId, documentId, commentId), del())
    },
    async createShare(projectId: string, documentId: string, settings: ShareSettings): Promise<ReviewShare | null> {
      return parseShareAnswer(await fetchApi<unknown>(`${documentPath(projectId, documentId)}/share`, post(settings)))
    },
    async revokeShare(projectId: string, documentId: string): Promise<void> {
      await fetchApi<unknown>(`${documentPath(projectId, documentId)}/share`, del())
    },
    /** 202 + an assist job polled through the project job read; resolves with what it filed. */
    personaReview(projectId: string, documentId: string, personaIds?: readonly string[]): Promise<PersonaReviewResult> {
      const body = personaIds === undefined ? {} : { persona_ids: personaIds }
      return runAssistJob(
        () => fetchApi<unknown>(`${documentPath(projectId, documentId)}/persona-review`, post(body)),
        (jobId) => projectsApi.getJobStatus(projectId, jobId),
        parsePersonaReviewResult,
      )
    },
  }
}

/** A reviewer's calls (board session). */
export function createReviewApi(fetchApi: FetchApi) {
  return {
    async get(shareId: string): Promise<ReviewPageAnswer> {
      return parseReviewAnswer(await fetchApi<unknown>(reviewPath(shareId)))
    },
    async comment(shareId: string, comment: NewComment): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${reviewPath(shareId)}/comments`, post(commentBody(comment))))
    },
    async reply(shareId: string, commentId: string, text: string): Promise<CommentThread> {
      return parseThreadAnswer(await fetchApi<unknown>(`${reviewPath(shareId)}/comments/${enc(commentId)}/replies`, post({ text })))
    },
  }
}

/** Resolved per call (a test mocking `./client` without `fetchApi` can still import this file). */
export const appDocumentCommentsApi = createDocumentCommentsApi((endpoint, options) => appFetchApi(endpoint, options))
