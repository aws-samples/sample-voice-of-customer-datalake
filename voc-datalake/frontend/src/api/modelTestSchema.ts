/**
 * @fileoverview Wire boundary for the Settings model test and capacity overview:
 * `POST /settings/model/test` and `GET /settings/model/capacity`
 * (lambda/shared/model_capacity.py).
 *
 * Lenient on purpose: an unknown `status` (a newer API) reads as `error`, a
 * malformed `quota` as unknown (null), and a capacity row without a model id is
 * dropped, so a surprising payload can degrade the pill but never crash the card.
 *
 * @module api/modelTestSchema
 */
import { z } from 'zod'

const MODEL_TEST_STATUSES = [
  'available', 'no_access', 'not_in_region', 'no_capacity', 'throttled', 'not_ready', 'unavailable', 'error',
] as const

export type ModelTestStatus = (typeof MODEL_TEST_STATUSES)[number]

const QuotaSchema = z.object({
  name: z.string(),
  tokens_per_minute: z.number().nonnegative(),
})

const LenientQuota = QuotaSchema.nullable().catch(null)

const ModelTestResultSchema = z.object({
  model_id: z.string(),
  invoked_id: z.string().catch(''),
  status: z.enum(MODEL_TEST_STATUSES).catch('error'),
  latency_ms: z.number().nonnegative().nullable().catch(null),
  message: z.string().catch(''),
  quota: LenientQuota,
  checked_at: z.string().catch(''),
})

export type ModelTestResult = z.infer<typeof ModelTestResultSchema>

/** The result recorded when a test produced nothing usable (bad payload, failed request). */
export function failedModelTestResult(modelId: string): ModelTestResult {
  return { model_id: modelId, invoked_id: '', status: 'error', latency_ms: null, message: '', quota: null, checked_at: '' }
}

/** The test result, or a synthetic `error` result for ``modelId`` when the payload is unusable. */
export function normalizeModelTestResult(raw: unknown, modelId: string): ModelTestResult {
  const parsed = ModelTestResultSchema.safeParse(raw)
  return parsed.success ? parsed.data : failedModelTestResult(modelId)
}

const CapacityRowSchema = z.object({
  model_id: z.string(),
  label: z.string().catch(''),
  quota: LenientQuota,
})

export type ModelCapacityRow = z.infer<typeof CapacityRowSchema>

/** The valid rows of `{models: [...]}`; anything else is an empty list. */
export function normalizeModelCapacity(raw: unknown): ModelCapacityRow[] {
  const envelope = z.object({ models: z.array(z.unknown()) }).safeParse(raw)
  if (!envelope.success) return []
  return envelope.data.models.flatMap((row) => {
    const parsed = CapacityRowSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}
