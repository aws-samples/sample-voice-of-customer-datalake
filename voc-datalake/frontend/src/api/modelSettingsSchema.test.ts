/**
 * The web search surface's parts of GET /settings/model (api/modelSettingsSchema.ts): lenient, so an older API
 * (neither field) reads as no GPT model and every surface on the Claude list, and a malformed row costs itself.
 */
import { describe, expect, it } from 'vitest'
import { normalizeWebSearchModels, readSurfaceAllowlist } from './modelSettingsSchema'

const LUNA = { key: 'gpt56luna', id: 'openai.gpt-5.6-luna', label: 'OpenAI GPT-5.6 Luna', description: 'Cheapest' }

describe('web_search_models', () => {
  it('keeps the valid rows, in order, and drops the rest', () => {
    expect(normalizeWebSearchModels([LUNA, { id: 7 }, 'x', { ...LUNA, id: 'openai.gpt-5.4', description: 3 }]))
      .toStrictEqual([LUNA, { ...LUNA, id: 'openai.gpt-5.4', description: '' }])
  })

  it.each([undefined, null, 'models', {}])('reads %s as no model', (raw) => {
    expect(normalizeWebSearchModels(raw)).toStrictEqual([])
  })
})

describe("a surface's allowlist", () => {
  it('is web_search only when it says so', () => {
    expect(readSurfaceAllowlist('web_search')).toBe('web_search')
  })

  it.each([undefined, 'claude', 'openai', 1])('is the Claude list otherwise (%s)', (raw) => {
    expect(readSurfaceAllowlist(raw)).toBe('claude')
  })
})
