/**
 * @fileoverview `GET /feedback/catalogue` (lambda/shared/feedback_catalogue.py, docs/data-catalogue.md): what
 * every stored attribute of a feedback item means. Parsed leniently: a malformed field row is dropped and the
 * rest kept, an unknown step, PII class or policy effect is kept as the server's string (the panel shows it
 * as is), and a malformed answer is an empty catalogue. Never throws.
 * @module api/feedbackCatalogueSchema
 */
import { z } from 'zod'
import { parseEach } from './lenientFields'

const stringList = z.array(z.unknown()).catch([]).transform((values) =>
  values.flatMap((value) => (typeof value === 'string' ? [value] : [])))

const SubFieldSchema = z.object({ name: z.string().min(1), type: z.string().catch('') })

const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().catch(''),
  meaning: z.string().catch(''),
  set_by: stringList,
  always_present: z.boolean().catch(false),
  key: z.boolean().catch(false),
  pii: z.string().catch(''),
  under_redact: z.string().catch(''),
  under_summary_only: z.string().catch(''),
  values: stringList.optional(),
  /** `dimensions`: the built-in dimensions and their values. */
  builtin_dimensions: z.record(z.string(), stringList).optional().catch(undefined),
  /** `issue_attributes`: its sub-fields. */
  sub_fields: z.unknown().optional().transform((raw) => (raw === undefined ? undefined : parseEach(SubFieldSchema, raw))),
})
export type CatalogueField = z.output<typeof FieldSchema>

const NamedMeaningSchema = z.object({ name: z.string().min(1), meaning: z.string().catch('') })
export type CatalogueStep = z.output<typeof NamedMeaningSchema>

const CatalogueSchema = z.object({
  version: z.number().int().catch(0),
  table: z.string().catch(''),
  steps: z.unknown().transform((raw) => parseEach(NamedMeaningSchema, raw)),
  policy_effects: z.unknown().transform((raw) => parseEach(NamedMeaningSchema, raw)),
  fields: z.unknown().transform((raw) => parseEach(FieldSchema, raw)),
})
export type FeedbackCatalogue = z.output<typeof CatalogueSchema>

const EMPTY_CATALOGUE: FeedbackCatalogue = { version: 0, table: '', steps: [], policy_effects: [], fields: [] }

export function normalizeFeedbackCatalogue(raw: unknown): FeedbackCatalogue {
  const parsed = CatalogueSchema.safeParse(raw)
  return parsed.success ? parsed.data : EMPTY_CATALOGUE
}

/** The allowed values a field lists: its enum, the built-in dimensions' values, or its sub-fields' names. */
export function fieldValues(field: CatalogueField): string[] {
  if (field.values !== undefined && field.values.length > 0) return field.values
  if (field.builtin_dimensions !== undefined) {
    return Object.entries(field.builtin_dimensions).map(([key, values]) => `${key}: ${values.join(', ')}`)
  }
  return field.sub_fields?.map((sub) => sub.name) ?? []
}
