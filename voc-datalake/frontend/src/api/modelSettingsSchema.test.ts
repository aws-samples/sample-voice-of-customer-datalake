/**
 * The web search surface's parts of GET /settings/model (api/modelSettingsSchema.ts): lenient, so an older API
 * (neither field) reads as no GPT model and every surface on the Claude list, and a malformed row costs itself. The
 * deployment's own models (`custom_models`, 7.65.00) are read the same way.
 */
import { describe, expect, it } from 'vitest'
import { normalizeCustomModels, normalizeWebSearchModels, readSurfaceAllowlist } from './modelSettingsSchema'

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

const IMPORTED = {
  key: 'examplechat', id: 'arn:aws:bedrock:eu-central-1:111111111111:imported-model/abcd1234efgh',
  label: 'Example imported model', description: '', kind: 'imported', source: 'imported',
  surfaces: ['enrichment', 'memory'], eu: true, regions: ['eu-central-1'],
  capabilities: { tools: false, documents: false, json: true, temperature: true }, price: { in: 0.5, out: 1.5 },
}

describe('custom_models', () => {
  it('keeps the valid rows, in order, and drops a row without a kind, a source or a price', () => {
    const unpriced = Object.fromEntries(Object.entries(IMPORTED).filter(([key]) => key !== 'price'))
    expect(normalizeCustomModels([IMPORTED, { ...IMPORTED, kind: 'sagemaker' }, { ...IMPORTED, source: 'x' }, unpriced]))
      .toStrictEqual([IMPORTED])
  })

  it('reads malformed lists and flags as empty or false, and drops a negative price', () => {
    const [row] = normalizeCustomModels([{
      ...IMPORTED, surfaces: 'chat', regions: null, eu: 'yes', description: 1,
      capabilities: { tools: 'yes', documents: true, json: null, temperature: false },
    }])
    expect(row).toMatchObject({
      surfaces: [], regions: [], eu: false, description: '',
      capabilities: { tools: false, documents: true, json: false, temperature: false },
    })
    expect(normalizeCustomModels([{ ...IMPORTED, price: { in: -1, out: 1 } }])).toStrictEqual([])
  })

  it.each([undefined, null, 'models', {}])('reads %s as no custom model (an older API)', (raw) => {
    expect(normalizeCustomModels(raw)).toStrictEqual([])
  })
})
