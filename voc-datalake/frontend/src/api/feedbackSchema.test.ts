import { describe, it, expect } from 'vitest'
import { normalizeFeedbackItem, normalizeFeedbackItems } from './feedbackSchema'

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feedback_id: 'f1',
    source_id: 's1',
    source_platform: 'manual_import',
    source_channel: 'ui_test',
    brand_name: 'Acme',
    source_created_at: '2026-06-16T00:00:00Z',
    processed_at: '2026-06-16T01:00:00Z',
    original_text: 'Manual import review',
    original_language: 'en',
    category: 'app',
    journey_stage: 'usage',
    sentiment_label: 'positive',
    sentiment_score: 0.9,
    urgency: 'low',
    impact_area: 'tech',
    ...overrides,
  }
}

describe('normalizeFeedbackItem', () => {
  it('coerces a string sentiment_score to a number', () => {
    const item = normalizeFeedbackItem(rawItem({ sentiment_score: '0.9' }))
    expect(item.sentiment_score).toBe(0.9)
    expect(typeof item.sentiment_score).toBe('number')
    // The coerced value is now safe for numeric operations like .toFixed().
    expect(item.sentiment_score.toFixed(2)).toBe('0.90')
  })

  it('coerces a string rating to a number', () => {
    const item = normalizeFeedbackItem(rawItem({ rating: '5' }))
    expect(item.rating).toBe(5)
  })

  it('falls back to 0 for a non-numeric sentiment_score', () => {
    const item = normalizeFeedbackItem(rawItem({ sentiment_score: 'not-a-number' }))
    expect(item.sentiment_score).toBe(0)
  })

  it('leaves a null rating as undefined (so the UI shows an em dash, not 0)', () => {
    const item = normalizeFeedbackItem(rawItem({ rating: null }))
    expect(item.rating).toBeUndefined()
  })

  it('treats a missing rating as undefined', () => {
    const item = normalizeFeedbackItem(rawItem())
    expect(item.rating).toBeUndefined()
  })

  it('strips unknown DynamoDB-internal keys', () => {
    const item = normalizeFeedbackItem(rawItem({ pk: 'SOURCE#manual_import', gsi1pk: 'DATE#2026-06-16', ttl: 1813148029 }))
    expect(item).not.toHaveProperty('pk')
    expect(item).not.toHaveProperty('gsi1pk')
    expect(item).not.toHaveProperty('ttl')
  })

  it('keeps a numeric sentiment_score unchanged', () => {
    const item = normalizeFeedbackItem(rawItem({ sentiment_score: -0.75 }))
    expect(item.sentiment_score).toBe(-0.75)
  })
})

describe('normalizeFeedbackItems', () => {
  it('normalizes every item in a list, coercing mixed string/number scores', () => {
    const items = normalizeFeedbackItems([
      rawItem({ feedback_id: 'a', sentiment_score: '0.9', rating: '5' }),
      rawItem({ feedback_id: 'b', sentiment_score: 0, rating: 4 }),
    ])
    expect(items.map((i) => i.sentiment_score)).toEqual([0.9, 0])
    expect(items.map((i) => i.rating)).toEqual([5, 4])
  })
})
