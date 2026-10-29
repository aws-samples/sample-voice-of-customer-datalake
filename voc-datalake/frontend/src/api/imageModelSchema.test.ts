/**
 * The image model's wire boundary: `image_model` of GET /settings/model and `image` of
 * GET /settings/model/capacity. Lenient: unknown statuses read as `unknown`, a malformed
 * quota as null, a missing block as null.
 */
import { describe, it, expect } from 'vitest'
import { normalizeImageModelCapacity, normalizeImageModelInfo } from './imageModelSchema'

const INFO = { id: 'stability.stable-image-core-v1:1', label: 'Stable Image Core', region: 'us-west-2', avatars_enabled: true }
const QUOTA = { name: 'On-demand model inference requests per minute for Stability.ai Stable Image Core', value: 1500, unit: 'requests_per_minute' }

describe('the image model block', () => {
  it('reads a full block', () => {
    expect(normalizeImageModelInfo(INFO)).toStrictEqual(INFO)
  })

  it('is null without an id (an older API, or none configured)', () => {
    expect([normalizeImageModelInfo(undefined), normalizeImageModelInfo({ label: 'x' })]).toStrictEqual([null, null])
  })

  it('reads avatars as enabled when the flag is unreadable', () => {
    expect(normalizeImageModelInfo({ id: INFO.id, avatars_enabled: 'yes' })).toStrictEqual({
      id: INFO.id, label: '', region: '', avatars_enabled: true,
    })
  })
})

describe('the image capacity block', () => {
  it('reads access, quota and quota state', () => {
    const access = { status: 'not_subscribed', agreement: 'NOT_AVAILABLE', authorization: 'AUTHORIZED', entitlement: 'NOT_AVAILABLE', region_availability: 'AVAILABLE' }
    expect(normalizeImageModelCapacity({ ...INFO, access, quota: QUOTA, quota_state: 'stale' })).toStrictEqual({
      ...INFO, access, quota: QUOTA, quota_state: 'stale',
    })
  })

  it('reads an unknown access status as unknown', () => {
    expect(normalizeImageModelCapacity({ ...INFO, access: { status: 'maybe' }, quota: QUOTA })?.access.status).toBe('unknown')
  })

  it('reads a missing access block as unknown with empty fields', () => {
    expect(normalizeImageModelCapacity({ ...INFO, quota: QUOTA })?.access).toStrictEqual({
      status: 'unknown', agreement: '', authorization: '', entitlement: '', region_availability: '',
    })
  })

  it('drops a quota in another unit or a negative value, keeping the rest', () => {
    const tokens = normalizeImageModelCapacity({ ...INFO, quota: { ...QUOTA, unit: 'tokens_per_minute' } })
    const negative = normalizeImageModelCapacity({ ...INFO, quota: { ...QUOTA, value: -1 } })
    expect([tokens?.quota, negative?.quota, tokens?.id]).toStrictEqual([null, null, INFO.id])
  })

  it('reads an unknown quota state as unknown and a missing block as null', () => {
    expect([
      normalizeImageModelCapacity({ ...INFO, quota: null, quota_state: 'later' })?.quota_state,
      normalizeImageModelCapacity(null),
    ]).toStrictEqual(['unknown', null])
  })
})
