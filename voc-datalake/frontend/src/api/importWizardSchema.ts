/**
 * @fileoverview Wire shapes of the import wizard (7.67.00, docs/import-wizard.md): the answer of
 * `POST /scrapers/manual/detect` (lambda/shared/import_wizard.py `detect_view`) and of
 * `POST /feedback-forms/{id}/import` (lambda/api/feedback_form_handler.py `import_form_responses`). Lenient like the
 * other boundary schemas: an unknown kind reads `ignore`, a malformed column or refusal is dropped.
 *
 * @module api/importWizardSchema
 */
import { z } from 'zod'
import { eachOf } from './lenientFields'

/** The kinds a column can hold (lambda/shared/import_detect.py `KINDS`, pinned by importWizardSchema.test.ts). */
export const COLUMN_KINDS = [
  'id', 'date', 'rating_1_5', 'rating_1_10', 'nps_0_10', 'csat', 'choice', 'multi_choice', 'matrix_cell', 'open_text',
  'email', 'name', 'url', 'channel', 'ignore',
] as const
export type ColumnKind = (typeof COLUMN_KINDS)[number]
/** Dropped by default: the wizard warns and keeps them out unless a person picks another kind. */
export const PERSONAL_KINDS: ReadonlySet<ColumnKind> = new Set(['email', 'name'])
export const FILE_FORMATS = ['csv', 'tsv', 'json', 'xlsx'] as const
export type FileFormat = (typeof FILE_FORMATS)[number]
export const DATE_ORDERS = ['dmy', 'mdy', 'ymd'] as const
export type DateOrder = (typeof DATE_ORDERS)[number]
export type ImportTarget = 'reviews' | 'survey'

const kind = z.enum(COLUMN_KINDS).catch('ignore')
const dateOrder = z.enum(DATE_ORDERS).catch('dmy')
const reason = z.object({ code: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).catch({}) })

const columnSchema = z.object({
  header: z.string(),
  kind,
  confidence: z.number().min(0).max(1).catch(0),
  reasons: eachOf(reason),
  reason: z.string().catch(''),
  personal: z.boolean().catch(false),
  values: z.array(z.string()).catch([]),
  filled: z.number().int().nonnegative().catch(0),
  date_order: dateOrder.optional(),
  separator: z.string().optional().catch(undefined),
})
export type DetectedColumn = z.infer<typeof columnSchema>

/** The inferred imported form: its definition as the forms API takes it, and the import mapping of its rows. */
const formSchema = z.object({
  definition: z.record(z.string(), z.unknown()),
  mapping: z.record(z.string(), z.string()),
  problems: z.array(z.object({ header: z.string(), code: z.string() })).catch([]),
})
export type InferredForm = z.infer<typeof formSchema>

const detectSchema = z.object({
  format: z.enum(FILE_FORMATS),
  delimiter: z.string().catch(','),
  headers: z.array(z.string()).catch([]),
  row_count: z.number().int().nonnegative().catch(0),
  columns: eachOf(columnSchema),
  suggested: z.object({
    target: z.enum(['reviews', 'survey']).catch('reviews'),
    mapping: z.record(z.string(), kind).catch({}),
    date_order: dateOrder,
    form: formSchema.nullable().catch(null),
    form_problem: z.string().nullable().catch(null),
  }),
  table: z.object({
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    truncated: z.boolean().catch(false),
  }).optional().catch(undefined),
})
export type DetectAnswer = z.infer<typeof detectSchema>

export function parseDetectAnswer(raw: unknown): DetectAnswer {
  return detectSchema.parse(raw)
}

const refusal = z.object({ row: z.number().int(), code: z.string(), question_id: z.string().optional().catch(undefined) })
export type RowRefusal = z.infer<typeof refusal>

const importSchema = z.object({
  accepted: z.number().int().nonnegative().catch(0),
  refused: eachOf(refusal),
  refused_count: z.number().int().nonnegative().catch(0),
  run_id: z.string().optional().catch(undefined),
  raw_s3_key: z.string().nullable().optional().catch(undefined),
  errors: z.array(z.string()).optional().catch(undefined),
})
export type RowsImported = z.infer<typeof importSchema>

export function parseRowsImported(raw: unknown): RowsImported {
  return importSchema.parse(raw)
}
