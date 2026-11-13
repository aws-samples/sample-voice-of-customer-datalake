/**
 * @fileoverview The prototype feedback read (docs/prototype-builder.md Part 3):
 * `GET /projects/{id}/prototypes/{document_id}/feedback` (project EDIT), every pin
 * of the prototype's series grouped by screen and folded into items, normalized at
 * the boundary. The answer's frame (its `groups`, each item's id and pin ids) must
 * be there, or the answer is refused; a sparse field inside degrades to its default.
 * A pin's statuses and replies are the pins API's own shapes (api/prototypePinsApi).
 * @module api/prototypeFeedbackSchema
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { PIN_STATUSES, PinReplySchema } from './prototypePinsApi'

const text = z.string().catch('')
const count = z.number().int().nonnegative().catch(0)

const FeedbackPinSchema = z.object({
  pin_id: z.string().min(1),
  document_id: text,
  version: count,
  status: z.enum(PIN_STATUSES).catch('open'),
  created_at: text,
  addressed_by: z.string().nullish().catch(null).transform((value) => value ?? ''),
  flagged: z.boolean().catch(false),
  text,
  replies: z.array(PinReplySchema).catch([]),
})

const AnchorSchema = z.object({ route: text, selector: text, text_snippet: text })
const EMPTY_ANCHOR = { route: '', selector: '', text_snippet: '' }

const FeedbackItemSchema = z.object({
  item_id: z.string().min(1),
  pin_ids: z.array(z.string().min(1)).min(1),
  count,
  flagged: z.boolean().catch(false),
  text,
  anchor: AnchorSchema.catch(() => ({ ...EMPTY_ANCHOR })),
  /** The anchor fields the server keeps away from models (the editor still sees them). */
  unsafe_fields: z.array(z.string()).catch([]),
  first_at: text,
  pins: z.array(FeedbackPinSchema).catch([]),
}).transform((item) => ({ ...item, count: item.pin_ids.length }))

const FeedbackGroupSchema = z.object({
  route: text,
  route_unsafe: z.boolean().catch(false),
  items: z.array(FeedbackItemSchema),
})

const VersionReadSchema = z.object({ document_id: text, version: count })
const CutSchema = z.object({ document_id: text, version: count, reason: text })

const PrototypeFeedbackSchema = z.object({
  document_id: z.string(),
  versions_read: z.array(VersionReadSchema).catch([]),
  partial: z.boolean().catch(false),
  cut: z.array(CutSchema).catch([]),
  older_versions_unread: count,
  pin_count: count,
  groups: z.array(FeedbackGroupSchema),
})

export type PrototypeFeedback = z.infer<typeof PrototypeFeedbackSchema>
export type FeedbackGroup = PrototypeFeedback['groups'][number]
export type FeedbackItem = FeedbackGroup['items'][number]

/**
 * The feedback answer, or a thrown error when its frame is not the contract's
 * (no `groups` list, an item without an id or pins): the view shows its error state
 * rather than an empty list that would read as "no feedback". `count` is always
 * the item's own number of pin ids, so the selection's pin total cannot drift
 * from the ids it would send.
 */
export function parsePrototypeFeedback(raw: unknown): PrototypeFeedback {
  const parsed = PrototypeFeedbackSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The feedback response was malformed')
  return parsed.data
}

function feedbackPath(projectId: string, documentId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(documentId)}/feedback`
}

/** Every pin of the prototype's series, grouped and folded (docs/prototype-builder.md Part 3). */
export async function getPrototypeFeedback(projectId: string, documentId: string): Promise<PrototypeFeedback> {
  return parsePrototypeFeedback(await fetchApi<unknown>(feedbackPath(projectId, documentId)))
}
