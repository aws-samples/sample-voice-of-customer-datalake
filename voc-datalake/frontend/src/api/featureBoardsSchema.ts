/**
 * @fileoverview Lenient wire schemas of Feedback boards (`/feature-requests/boards*`,
 * docs/feature-requests.md): a board, its fields and statuses, its audience, and the field values
 * a request or support carries. Every part falls back on its own: a board whose `fields` or
 * `statuses` cannot be read takes its template's defaults (api/boardFields.ts) rather than
 * vanishing, and one malformed board in a listing costs exactly itself.
 *
 * @module api/featureBoardsSchema
 */
import { z } from 'zod'
import { BOARD_TEMPLATES, FIELD_LEVELS, LEVEL_FIELD_KEYS, MAX_STATUSES, MAX_STATUS_LABEL, STATUS_KEY, TEMPLATE_DEFAULTS, isFieldKey } from './boardFields'
import type { BoardFields, BoardStatus, BoardTemplate, FieldKey, FieldLevel, LevelFields } from './boardFields'
import { lenientText, parsedList } from './schemaList'
import { toOptionalFiniteNumber } from './lenientFields'

/** The id of the board every pre-boards request belongs to (seeded by the API on first listing). */
export const SEEDED_BOARD_ID = 'brd_sales'

/** A whole, non-negative number; anything else (absent, junk, negative) reads as 0. */
export const count = z.unknown().optional().transform((value) => {
  const n = toOptionalFiniteNumber(value)
  return n !== undefined && n >= 0 ? Math.trunc(n) : 0
})

/** Catalogue field values by key (text or number); unknown keys and other types are dropped. */
export type FieldValues = Readonly<Partial<Record<FieldKey, string | number>>>

/** A request's or support's `fields`; undefined when the backend sent none. */
export const fieldValuesSchema = z.record(z.string(), z.unknown()).optional().catch(undefined).transform((raw): FieldValues | undefined => {
  if (raw === undefined) return undefined
  const kept: Partial<Record<FieldKey, string | number>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isFieldKey(key) && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) kept[key] = value
  }
  return kept
})

const switchSchema = z.object({ enabled: z.boolean().catch(false), required: z.boolean().catch(false) })
  .catch({ enabled: false, required: false })
  .transform((value) => ({ enabled: value.enabled, required: value.enabled && value.required }))

const objectSchema = z.record(z.string(), z.unknown())

/** One level's switches: its catalogue keys as sent (absent = off); keys outside it stay off. */
function readLevel(raw: Record<string, unknown>, level: FieldLevel): LevelFields {
  return Object.fromEntries(LEVEL_FIELD_KEYS[level].map((key) => [key, switchSchema.parse(raw[key])]))
}

/** `{request: {...}, support: {...}}`; unreadable = the template's defaults. */
function readFields(raw: unknown, template: BoardTemplate): BoardFields {
  const parsed = objectSchema.safeParse(raw)
  if (!parsed.success) return TEMPLATE_DEFAULTS[template].fields
  const level = (name: FieldLevel) => readLevel(objectSchema.catch({}).parse(parsed.data[name]), name)
  return { request: level(FIELD_LEVELS[0]), support: level(FIELD_LEVELS[1]) }
}

/** A status as the board stores it; a label longer than the API allows is shown clipped, not dropped. */
const statusSchema = z.object({
  key: z.string().regex(STATUS_KEY),
  label: z.string().trim().min(1).transform((label) => label.slice(0, MAX_STATUS_LABEL)),
})

function readStatuses(raw: unknown, template: BoardTemplate): readonly BoardStatus[] {
  const statuses = parsedList(statusSchema).parse(raw).slice(0, MAX_STATUSES)
  return statuses.length === 0 ? TEMPLATE_DEFAULTS[template].statuses : statuses
}

export const AUDIENCE_MODES = ['company', 'list', 'anyone'] as const
export type AudienceMode = typeof AUDIENCE_MODES[number]

const stringList = z.array(z.unknown()).optional().catch(undefined)
  .transform((items) => items?.filter((item): item is string => typeof item === 'string' && item !== ''))

/** Non-admins get `{mode}` only: `domains` / `emails` are then undefined, never guessed. */
const audienceSchema = z.object({
  // Fail closed to the narrowest audience a reader can name.
  mode: z.enum(AUDIENCE_MODES).catch('company'),
  domains: stringList,
  emails: stringList,
}).catch({ mode: 'company', domains: undefined, emails: undefined })

const boardWireSchema = z.object({
  board_id: z.string().min(1),
  slug: z.string().min(1),
  name: lenientText,
  description: lenientText,
  template: z.enum(BOARD_TEMPLATES).catch('blank'),
  fields: z.unknown(),
  statuses: z.unknown(),
  audience: audienceSchema,
  archived: z.boolean().catch(false),
  /** Temporary: still readable by its audience, but no new request, +1 or edit until an admin resumes it. */
  paused: z.boolean().catch(false),
  request_count: count,
  share_url: lenientText,
  created_at: lenientText,
  updated_at: lenientText,
})

export const boardSchema = boardWireSchema.transform((board) => ({
  ...board,
  name: board.name === '' ? board.slug : board.name,
  fields: readFields(board.fields, board.template),
  statuses: readStatuses(board.statuses, board.template),
}))
export type FeatureBoard = z.infer<typeof boardSchema>

/**
 * The board a client shows when the API named none (a pre-boards API, a pre-boards fixture): the
 * seeded Sales board with its template defaults, so the old single board keeps working.
 */
export const SEEDED_BOARD: FeatureBoard = {
  board_id: SEEDED_BOARD_ID,
  slug: 'sales-feature-requests',
  name: 'Sales feature requests',
  description: '',
  template: 'sales',
  fields: TEMPLATE_DEFAULTS.sales.fields,
  statuses: TEMPLATE_DEFAULTS.sales.statuses,
  audience: { mode: 'company', domains: undefined, emails: undefined },
  archived: false,
  paused: false,
  request_count: 0,
  share_url: '',
  created_at: '',
  updated_at: '',
}

/**
 * One answer of `DELETE /feature-requests/boards/{id}`: `done` once the board itself is gone, else
 * how many requests this call deleted and how many remain (`?with_requests=true` deletes them a page
 * per call). An older API answers just `{success: true}`: that reads as done.
 */
export const deleteBoardStepSchema = z.object({
  done: z.boolean().optional().catch(undefined).transform((done) => done ?? true),
  deleted: count,
  remaining: count,
}).catch({ done: true, deleted: 0, remaining: 0 })
export type DeleteBoardStep = z.infer<typeof deleteBoardStepSchema>

/** What an admin sends to create a board. */
export interface NewBoardInput {
  readonly name: string
  readonly template: BoardTemplate
  readonly slug?: string
  readonly description?: string
  readonly audience?: { readonly mode: AudienceMode; readonly domains?: readonly string[]; readonly emails?: readonly string[] }
}

/** What an admin may change on a board (any subset). */
export interface BoardPatch {
  readonly name?: string
  readonly slug?: string
  readonly description?: string
  readonly fields?: BoardFields
  readonly statuses?: readonly BoardStatus[]
  readonly audience?: NonNullable<NewBoardInput['audience']>
  readonly archived?: boolean
  readonly paused?: boolean
}
