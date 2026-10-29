/**
 * @fileoverview Wire boundary for the persona-avatar image model in Administration → AI models
 * (lambda/shared/image_model_status.py):
 * - `GET /settings/model` → `image_model: {id, label, region, avatars_enabled}`;
 * - `GET /settings/model/capacity` → `image: {…, access: {status, …}, quota, quota_state}`.
 *
 * Lenient like modelTestSchema.ts: an unknown access status reads as `unknown`, a malformed
 * quota as null, and a missing or malformed block as null (an older API has none), so the row
 * degrades or hides but never crashes the card.
 *
 * @module api/imageModelSchema
 */
import { z } from 'zod'

const ACCESS_STATUSES = ['available', 'no_access', 'not_subscribed', 'not_in_region', 'unknown'] as const

export type ImageAccessStatus = (typeof ACCESS_STATUSES)[number]

const QUOTA_STATES = ['fresh', 'stale', 'pending', 'unknown'] as const

const ImageModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().catch(''),
  region: z.string().catch(''),
  avatars_enabled: z.boolean().catch(true),
})

export type ImageModelInfo = z.infer<typeof ImageModelInfoSchema>

const ImageAccessSchema = z.object({
  status: z.enum(ACCESS_STATUSES).catch('unknown'),
  agreement: z.string().catch(''),
  authorization: z.string().catch(''),
  entitlement: z.string().catch(''),
  region_availability: z.string().catch(''),
})

const ImageQuotaSchema = z.object({
  name: z.string(),
  value: z.number().nonnegative(),
  unit: z.literal('requests_per_minute'),
})

const ImageCapacitySchema = ImageModelInfoSchema.extend({
  access: ImageAccessSchema.catch({
    status: 'unknown', agreement: '', authorization: '', entitlement: '', region_availability: '',
  }),
  quota: ImageQuotaSchema.nullable().catch(null),
  quota_state: z.enum(QUOTA_STATES).catch('unknown'),
})

export type ImageModelCapacity = z.infer<typeof ImageCapacitySchema>

/** The `image_model` block of `GET /settings/model`, or null when absent or unusable. */
export function normalizeImageModelInfo(raw: unknown): ImageModelInfo | null {
  const parsed = ImageModelInfoSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The `image` block of `GET /settings/model/capacity`, or null when absent or unusable. */
export function normalizeImageModelCapacity(raw: unknown): ImageModelCapacity | null {
  const parsed = ImageCapacitySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
