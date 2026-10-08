/**
 * The approval boundary's validation of a feedback form's `dimension_defaults`
 * and `tags` (mirrors lambda/shared/dimension_config.py; docs/dimensions.md).
 */
import { describe, it, expect } from 'vitest'
import { feedbackFormUpdatesSchema } from './schemas'

describe('feedback form dimension defaults and tags (docs/dimensions.md)', () => {
  it('accepts valid defaults and tags', () => {
    const parsed = feedbackFormUpdatesSchema.safeParse({ dimension_defaults: { user_type: 'partner' }, tags: ['sales', ' beta '] })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.tags).toStrictEqual(['sales', 'beta'])
  })

  it.each([
    ['an invalid dimension key', { dimension_defaults: { 'User Type': 'partner' } }],
    ['a value with a separator', { dimension_defaults: { product: 'a,b' } }],
    ['more than 10 defaults', { dimension_defaults: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) }],
    ['a tag with a separator', { tags: ['a#b'] }],
    ['more than 20 tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
  ])('refuses %s', (_label, updates) => {
    expect(feedbackFormUpdatesSchema.safeParse(updates).success).toBe(false)
  })
})
