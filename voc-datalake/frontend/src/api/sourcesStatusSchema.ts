/**
 * @fileoverview Runtime normalization for `GET /sources/status` (batch form) and
 * `POST /sources/{source}/reset`.
 *
 * Each source carries its schedule state plus `circuit` — the plugin circuit
 * breaker (plugins/_shared/circuit_breaker.py): `tripped` while repeated failures
 * have paused the source. Lenient like api/scrapersSchema.ts: a field that is
 * missing or the wrong type degrades to the closed / disabled reading instead of
 * rejecting the record, and a record from a backend that predates `circuit`
 * reads as closed.
 *
 * @module api/sourcesStatusSchema
 */
import { z } from 'zod'
import { toOptionalFiniteNumber } from './lenientFields'

const nullableString = z.string().nullable().catch(null)
const optionalString = z.string().optional().catch(undefined)

const closedCircuit = () => ({ tripped: false, tripped_at: null, failure_count: 0, last_error: null })

/**
 * `last_error` is the plugin's last error, bounded; `null` for non-admins (the
 * server withholds it). `error` is set when the server could not read the state.
 */
const CircuitSchema = z
  .object({
    tripped: z.boolean().catch(false),
    tripped_at: nullableString,
    failure_count: z.preprocess(toOptionalFiniteNumber, z.number().int().nonnegative().catch(0)),
    last_error: nullableString,
    error: optionalString,
  })
  .catch(closedCircuit)

export type SourceCircuit = z.infer<typeof CircuitSchema>

/** What a source with no TRIPPED row (or a backend that predates `circuit`) reads as. */
export const CLOSED_CIRCUIT: SourceCircuit = Object.freeze(closedCircuit())

const SourceStatusSchema = z
  .looseObject({
    enabled: z.boolean().catch(false),
    schedule: optionalString,
    rule_name: optionalString,
    exists: z.boolean().optional().catch(undefined),
    error: optionalString,
    circuit: CircuitSchema,
  })
  .catch(() => ({ enabled: false, circuit: closedCircuit() }))

export type SourceStatus = z.infer<typeof SourceStatusSchema>

const SourcesStatusSchema = z
  .object({ sources: z.record(z.string(), SourceStatusSchema).catch({}) })
  .catch(() => ({ sources: {} }))

export type SourcesStatus = z.infer<typeof SourcesStatusSchema>

export function normalizeSourcesStatus(raw: unknown): SourcesStatus {
  return SourcesStatusSchema.parse(raw)
}

const ResetSourceSchema = z
  .looseObject({
    success: z.boolean().catch(false),
    source: z.string().catch(''),
    enabled: z.boolean().catch(false),
    circuit: CircuitSchema,
  })
  .catch(() => ({ success: false, source: '', enabled: false, circuit: closedCircuit() }))

type ResetSourceResponse = z.infer<typeof ResetSourceSchema>

export function normalizeResetSource(raw: unknown): ResetSourceResponse {
  return ResetSourceSchema.parse(raw)
}
