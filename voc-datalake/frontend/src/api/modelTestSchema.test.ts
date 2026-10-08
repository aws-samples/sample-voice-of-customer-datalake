import { describe, it, expect } from 'vitest'
import { normalizeModelCapacity, normalizeModelTestResult } from './modelTestSchema'

const OPUS55 = 'global.anthropic.claude-opus-5-5'

describe('normalizeModelTestResult', () => {
  it('keeps a well-formed result', () => {
    const raw = {
      model_id: OPUS55, invoked_id: 'eu.anthropic.claude-opus-5-5', status: 'no_capacity', ok: false,
      latency_ms: null, message: 'wait', quota: { name: 'q', tokens_per_minute: 0 }, checked_at: 'now',
    }

    expect(normalizeModelTestResult(raw, OPUS55)).toStrictEqual({
      model_id: OPUS55, invoked_id: 'eu.anthropic.claude-opus-5-5', status: 'no_capacity',
      latency_ms: null, message: 'wait', quota: { name: 'q', tokens_per_minute: 0 }, checked_at: 'now',
    })
  })

  it('reads an unknown status as error and a malformed quota as unknown', () => {
    const parsed = normalizeModelTestResult({ model_id: OPUS55, status: 'brand_new', quota: { tokens_per_minute: 'x' } }, OPUS55)

    expect([parsed.status, parsed.quota, parsed.latency_ms]).toStrictEqual(['error', null, null])
  })

  it('turns an unusable payload into an error result for the requested model', () => {
    expect(normalizeModelTestResult('oops', OPUS55)).toMatchObject({ model_id: OPUS55, status: 'error' })
  })
})

describe('normalizeModelCapacity', () => {
  it('drops rows without a model id and keeps the rest', () => {
    const rows = normalizeModelCapacity({
      models: [{ model_id: OPUS55, label: 'Claude Opus 5.5', quota: null }, { label: 'no id' }],
    })

    expect(rows).toStrictEqual([{ model_id: OPUS55, label: 'Claude Opus 5.5', quota: null }])
  })

  it('is an empty list for a missing envelope', () => {
    expect(normalizeModelCapacity(null)).toStrictEqual([])
  })
})
