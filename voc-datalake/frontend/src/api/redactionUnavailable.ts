/**
 * @fileoverview `redaction_unavailable` (7.71.04, docs/source-policies.md): what a manual reviews import, a CSV and a
 * JSON upload answer when the source's strict redaction left rows out because the entity model could not read them.
 * One shape for the three, `{count, rows}`: `rows` are the rows' 1-based places in what was sent (a CSV's row
 * numbers, a pasted review's or a JSON item's position in its list), the first 100 named; `count` is whole. Lenient
 * like the other boundary schemas: a malformed answer reads as none, a row that is not a whole number above 0 is
 * dropped.
 *
 * @module api/redactionUnavailable
 */
import { z } from 'zod'
import { lenientList } from './lenientFields'

const isRow = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

/** The field as an upload's answer schema reads it: undefined when the upload left nothing out. */
export const RedactionUnavailableSchema = z.object({
  count: z.number().int().positive(),
  rows: lenientList(isRow),
}).optional().catch(undefined)

export type RedactionUnavailable = NonNullable<z.infer<typeof RedactionUnavailableSchema>>
