/**
 * @fileoverview Wire shapes of document comments, review links and the review page
 * (lambda/shared/document_comments.py, document_share.py, document_review_routes.py;
 * docs/document-review.md). Lenient at the boundary: an unreadable thread is dropped, an
 * unreadable field falls back, so one bad row never blanks the comments.
 *
 * @module api/documentReviewSchema
 */
import { z } from 'zod'

export const AUTHOR_KINDS = ['user', 'persona', 'reviewer'] as const
export type CommentAuthorKind = (typeof AUTHOR_KINDS)[number]

const authorSchema = z.object({
  kind: z.enum(AUTHOR_KINDS).catch('user'),
  name: z.string().catch(''),
  persona_id: z.string().optional().catch(undefined),
  /** A teammate's Cognito sub (team view only). */
  sub: z.string().optional().catch(undefined),
  email: z.string().optional().catch(undefined),
})
export type CommentAuthor = z.infer<typeof authorSchema>

const anchorSchema = z.object({
  exact: z.string().min(1),
  prefix: z.string().catch(''),
  suffix: z.string().catch(''),
  heading: z.string().catch(''),
})
export type TextQuoteAnchor = z.infer<typeof anchorSchema>

const replySchema = z.object({
  reply_id: z.string().catch(''),
  author: authorSchema.catch({ kind: 'user', name: '' }),
  text: z.string().catch(''),
  flagged: z.boolean().catch(false),
  at: z.string().catch(''),
})
const STANCES = ['positive', 'mixed', 'negative'] as const

const threadSchema = z.object({
  comment_id: z.string().min(1),
  document_id: z.string().catch(''),
  version: z.number().nullable().catch(null),
  text: z.string().catch(''),
  anchor: anchorSchema.nullable().catch(null),
  status: z.enum(['open', 'resolved']).catch('open'),
  flagged: z.boolean().catch(false),
  created_at: z.string().catch(''),
  author: authorSchema.catch({ kind: 'user', name: '' }),
  replies: z.array(replySchema).catch([]),
  verdict: z.enum(STANCES).optional().catch(undefined),
  from_review_link: z.boolean().catch(false),
})
export type CommentThread = z.infer<typeof threadSchema>

/** Threads, dropping any row that is not one (lenient list boundary). */
const threadListSchema = z.array(z.unknown()).catch([]).transform((rows) =>
  rows.flatMap((row) => {
    const parsed = threadSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  }))

export const SHARE_MODES = ['anyone', 'list'] as const
export type ShareMode = (typeof SHARE_MODES)[number]

const audienceSchema = z.object({
  mode: z.enum(SHARE_MODES).catch('anyone'),
  domains: z.array(z.string()).catch([]),
  emails: z.array(z.string()).catch([]),
})
export type ShareAudience = z.infer<typeof audienceSchema>

const shareSchema = z.object({
  share_id: z.string().min(1),
  path: z.string().min(1),
  audience: audienceSchema.catch({ mode: 'anyone', domains: [], emails: [] }),
  created_at: z.string().catch(''),
  created_by_name: z.string().catch(''),
  expires_at: z.string().catch(''),
  active: z.boolean().catch(true),
})
export type ReviewShare = z.infer<typeof shareSchema>

const commentsAnswerSchema = z.object({
  threads: threadListSchema,
  share: shareSchema.nullable().catch(null),
  can_edit: z.boolean().catch(false),
})
export type DocumentCommentsAnswer = z.infer<typeof commentsAnswerSchema>

const threadAnswerSchema = z.object({ thread: threadSchema })
const shareAnswerSchema = z.object({ share: shareSchema.nullable().catch(null) })

const reviewAnswerSchema = z.object({
  share: z.object({ share_id: z.string(), document_type: z.string().catch(''), expires_at: z.string().catch('') }),
  document: z.object({
    document_id: z.string().catch(''), version: z.number().nullable().catch(null),
    title: z.string().catch(''), content: z.string().catch(''),
  }),
  threads: threadListSchema,
  viewer: z.object({ email: z.string().catch(''), name: z.string().catch('') }).catch({ email: '', name: '' }),
})
export type ReviewPageAnswer = z.infer<typeof reviewAnswerSchema>

const personaReviewResultSchema = z.object({
  filed: z.number().catch(0),
  personas: z.array(z.object({
    persona_id: z.string().catch(''), name: z.string().catch(''), ok: z.boolean().catch(false),
    filed: z.number().catch(0), dropped: z.number().catch(0),
  })).catch([]),
})
export type PersonaReviewResult = z.infer<typeof personaReviewResultSchema>

function parsed<S extends z.ZodType>(schema: S, answer: unknown): z.output<S> {
  const result = schema.safeParse(answer)
  if (!result.success) throw new Error('Unexpected response from the server.')
  return result.data
}

export const parseCommentsAnswer = (answer: unknown): DocumentCommentsAnswer => parsed(commentsAnswerSchema, answer)
export const parseThreadAnswer = (answer: unknown): CommentThread => parsed(threadAnswerSchema, answer).thread
export const parseShareAnswer = (answer: unknown): ReviewShare | null => parsed(shareAnswerSchema, answer).share
export const parseReviewAnswer = (answer: unknown): ReviewPageAnswer => parsed(reviewAnswerSchema, answer)
export const parsePersonaReviewResult = (answer: unknown): PersonaReviewResult => parsed(personaReviewResultSchema, answer)
