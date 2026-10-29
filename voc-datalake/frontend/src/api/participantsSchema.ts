/**
 * @fileoverview Lenient wire schemas for the participants API (docs/participants.md):
 * lists, people, asks and their recipients, the engagement settings.
 *
 * The `formSchema.ts` precedent: every field but the id degrades to a default instead of
 * rejecting the record, a record without its id is dropped (an invented id would collide
 * React keys and query keys), and one malformed row in a list costs exactly itself.
 *
 * @module api/participantsSchema
 */
import { z } from 'zod'
import { nonBlankStringList, toOptionalFiniteNumber } from './lenientFields'
import { parsedList } from './schemaList'

export const LIST_KINDS = ['employees', 'paid', 'beta', 'sales', 'customers', 'requesters', 'custom'] as const
export type ListKind = typeof LIST_KINDS[number]

const PERSON_STATUSES = ['active', 'unsubscribed'] as const
export type PersonStatus = typeof PERSON_STATUSES[number]

const ASK_STATUSES = ['queued', 'sending', 'sent', 'failed'] as const
export type AskStatus = typeof ASK_STATUSES[number]

const RECIPIENT_STATUSES = ['queued', 'sent', 'failed', 'skipped_unsubscribed', 'responded'] as const
export type RecipientStatus = typeof RECIPIENT_STATUSES[number]

const REJECT_REASONS = ['invalid_email', 'external_not_allowed', 'unsubscribed'] as const
export type RejectReason = typeof REJECT_REASONS[number]

export function isListKind(value: string): value is ListKind {
  return LIST_KINDS.some((kind) => kind === value)
}

const text = z.string().catch('')
/** An optional timestamp / id: absent, null and wrong-typed all read as null. */
const nullableText = z.string().min(1).nullable().catch(null)
const count = z.preprocess(toOptionalFiniteNumber, z.number().int().nonnegative().catch(0))

const listSchema = z.object({
  list_id: z.string().min(1),
  name: text,
  description: text,
  kind: z.enum(LIST_KINDS).catch('custom'),
  member_count: count,
  created_by: text,
  created_at: text,
  updated_at: text,
  feature_request_id: nullableText,
})
export type ParticipantList = z.infer<typeof listSchema>

const personSchema = z.object({
  person_id: z.string().min(1),
  email: text,
  name: text,
  company: text,
  title: text,
  notes: text,
  tags: nonBlankStringList,
  status: z.enum(PERSON_STATUSES).catch('active'),
  unsubscribed_at: nullableText,
  origin: z.enum(['manual', 'assistant', 'feature_request']).catch('manual'),
  created_at: text,
  updated_at: text,
  /** The lists the person is on, when the listing carries them (absent = not shown). */
  list_ids: nonBlankStringList.optional().catch(undefined),
})
export type Person = z.infer<typeof personSchema>

const linkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('form'), form_id: text, url: text }),
  z.object({ kind: z.literal('url'), url: text }),
]).nullable().catch(null)

const countsSchema = z.object({
  recipients: count, sent: count, failed: count, skipped: count, responded: count,
}).catch({ recipients: 0, sent: 0, failed: 0, skipped: 0, responded: 0 })
export type AskCounts = z.infer<typeof countsSchema>

const askSchema = z.object({
  ask_id: z.string().min(1),
  project_id: nullableText,
  subject: text,
  message: text,
  link: linkSchema,
  counts: countsSchema,
  status: z.enum(ASK_STATUSES).catch('queued'),
  created_by: text,
  created_at: text,
})
export type Ask = z.infer<typeof askSchema>

const recipientSchema = z.object({
  person_id: z.string().min(1),
  /** Null once the person was erased. */
  email: nullableText,
  name: nullableText,
  status: z.enum(RECIPIENT_STATUSES).catch('queued'),
  sent_at: nullableText,
  responded_at: nullableText,
  error: nullableText,
})
export type AskRecipient = z.infer<typeof recipientSchema>

const personAskSchema = z.object({
  ask_id: z.string().min(1),
  subject: text,
  status: z.enum(RECIPIENT_STATUSES).catch('queued'),
  sent_at: nullableText,
  responded_at: nullableText,
})

const DEFAULT_DAILY_SEND_CAP = 500
/** The route's bounds on `daily_send_cap` (brief: 1–5000). */
export const MAX_DAILY_SEND_CAP = 5000

const settingsSchema = z.object({
  company_domains: nonBlankStringList,
  allow_external_people: z.boolean().catch(true),
  daily_send_cap: z.preprocess(toOptionalFiniteNumber, z.number().int().min(1).max(MAX_DAILY_SEND_CAP).catch(DEFAULT_DAILY_SEND_CAP)),
  sender_name: text,
  updated_at: nullableText,
  updated_by: nullableText,
}).catch({
  company_domains: [], allow_external_people: true, daily_send_cap: DEFAULT_DAILY_SEND_CAP,
  sender_name: '', updated_at: null, updated_by: null,
})
export type EngagementSettings = z.infer<typeof settingsSchema>

const lists = parsedList(listSchema)
const people = parsedList(personSchema)

const listsResponse = z.object({ lists }).catch({ lists: [] })
const listDetailResponse = z.object({ list: listSchema, members: people })
const listResponse = z.object({ list: listSchema })
const peopleResponse = z.object({ people }).catch({ people: [] })
const personResponse = z.object({ person: personSchema })
const personDetailResponse = z.object({ person: personSchema, lists, asks: parsedList(personAskSchema) })
const rejectedSchema = z.object({ email: text, reason: z.enum(REJECT_REASONS).catch('invalid_email') })
const projectResponse = z.object({ lists, people, reach: count }).catch({ lists: [], people: [], reach: 0 })
/** POST answers the same plus what inviting new people did (`created`, `rejected`). */
const projectLinkResponse = z.object({
  lists, people, reach: count, created: count, rejected: parsedList(rejectedSchema),
}).catch({ lists: [], people: [], reach: 0, created: 0, rejected: [] })
const asksResponse = z.object({ asks: parsedList(askSchema) }).catch({ asks: [] })
const askResponse = z.object({ ask: askSchema })
const askDetailResponse = z.object({ ask: askSchema, recipients: parsedList(recipientSchema) })
const settingsResponse = z.object({
  settings: settingsSchema,
  email_enabled: z.boolean().catch(false),
  board_enabled: z.boolean().catch(false),
  board_url: text,
}).catch({ settings: settingsSchema.parse(undefined), email_enabled: false, board_enabled: false, board_url: '' })
const savedSettingsResponse = z.object({ settings: settingsSchema })
const addMembersResponse = z.object({
  added: count, already: count, created: count, rejected: parsedList(rejectedSchema),
}).catch({ added: 0, already: 0, created: 0, rejected: [] })
const formsResponse = z.object({
  forms: parsedList(z.object({ form_id: z.string().min(1), name: text, enabled: z.boolean().catch(false) })),
}).catch({ forms: [] })

export type ListDetail = z.infer<typeof listDetailResponse>
export type PersonDetail = z.infer<typeof personDetailResponse>
export type ProjectParticipants = z.infer<typeof projectResponse>
export type ProjectLinkResult = z.infer<typeof projectLinkResponse>
export type AskDetail = z.infer<typeof askDetailResponse>
export type SettingsView = z.infer<typeof settingsResponse>
export type AddMembersResult = z.infer<typeof addMembersResponse>
export type FormOption = z.infer<typeof formsResponse>['forms'][number]

/** A response that must carry its record: a missing or id-less one is an error, not a blank record. */
function required<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`Malformed ${what} response`)
  return parsed.data
}

export const normalize = {
  lists: (raw: unknown): ParticipantList[] => listsResponse.parse(raw).lists,
  list: (raw: unknown): ParticipantList => required(listResponse, raw, 'list').list,
  listDetail: (raw: unknown): ListDetail => required(listDetailResponse, raw, 'list'),
  people: (raw: unknown): Person[] => peopleResponse.parse(raw).people,
  person: (raw: unknown): Person => required(personResponse, raw, 'person').person,
  personDetail: (raw: unknown): PersonDetail => required(personDetailResponse, raw, 'person'),
  project: (raw: unknown): ProjectParticipants => projectResponse.parse(raw),
  projectLink: (raw: unknown): ProjectLinkResult => projectLinkResponse.parse(raw),
  asks: (raw: unknown): Ask[] => asksResponse.parse(raw).asks,
  ask: (raw: unknown): Ask => required(askResponse, raw, 'ask').ask,
  askDetail: (raw: unknown): AskDetail => required(askDetailResponse, raw, 'ask'),
  settings: (raw: unknown): SettingsView => settingsResponse.parse(raw),
  savedSettings: (raw: unknown): EngagementSettings => required(savedSettingsResponse, raw, 'settings').settings,
  addMembers: (raw: unknown): AddMembersResult => addMembersResponse.parse(raw),
  forms: (raw: unknown): FormOption[] => formsResponse.parse(raw).forms,
}
