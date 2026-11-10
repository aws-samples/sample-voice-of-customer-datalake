/** The approval boundary's id rule (WA SEC11, FE-1): ids become API path segments. */
import { describe, expect, it } from 'vitest'
import { idSchema } from './schemas'

describe('idSchema refuses dot-only ids (a URL parser resolves /documents/.. to the parent route)', () => {
  it.each(['.', '..'])('refuses %j', (id) => {
    expect(idSchema.safeParse(id).success).toBe(false)
  })

  it.each(['doc_1', 'v1.2', '...', '.hidden', 'a..b'])('accepts %j', (id) => {
    expect(idSchema.safeParse(id).success).toBe(true)
  })
})
