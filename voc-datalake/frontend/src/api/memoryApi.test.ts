/**
 * @fileoverview The review-queue wire contract with `memory_handler.py`.
 *
 * `GET /memory/review` sends `{memory, linked, suggestion}` per entry
 * (`_review_entry`), and `suggestion` names its winner. The page reads
 * `{conflicts, suggested_resolution}`; until the F1 fix the route only ever 502'd,
 * so the mismatch never reached a screen. These pin the translation both ways.
 */
import { describe, expect, it } from 'vitest'
import { normalizeReview, resolveRequest } from './memoryApi'

const item = (memoryId: string, statement: string) => ({
  memory_id: memoryId, scope: 'company', status: 'conflict', kind: 'product', statement, supporters: 1,
  source_kind: 'extracted', created_at: '2026-10-01T00:00:00Z',
})

describe('normalizeReview', () => {
  it('reads the handler shape: linked → conflicts, suggestion → suggested_resolution', () => {
    const [entry] = normalizeReview({ count: 1, items: [{
      memory: item('new', 'No express shipping in the north'),
      linked: [item('old', 'Express shipping everywhere')],
      suggestion: { action: 'keep', winner_id: 'new', reason: 'A person stated this explicitly.' },
    }] })
    expect(entry?.conflicts.map((c) => c.memory_id)).toStrictEqual(['old'])
    expect(entry?.suggested_resolution).toStrictEqual({ action: 'keep', winner_id: 'new', reason: 'A person stated this explicitly.' })
  })

  it('names a suggested win for the OTHER side the UI\'s replace ("Keep the existing one")', () => {
    const [entry] = normalizeReview({ items: [{
      memory: item('new', 'A'), linked: [item('old', 'B')],
      suggestion: { action: 'keep', winner_id: 'old', reason: '6 people support it versus 1.' },
    }] })
    expect(entry?.suggested_resolution?.action).toBe('replace')
  })

  it('keeps a merge suggestion and a winner it cannot place as they are', () => {
    const [merge, stray] = normalizeReview({ items: [
      { memory: item('a', 'A'), linked: [item('b', 'B')], suggestion: { action: 'merge', winner_id: null, reason: 'Similar support.' } },
      { memory: item('c', 'C'), linked: [], suggestion: { action: 'keep', winner_id: 'zzz' } },
    ] })
    expect(merge?.suggested_resolution?.action).toBe('merge')
    expect(stray?.suggested_resolution?.action).toBe('keep')
  })

  it('still accepts the older conflicts / suggested_resolution keys', () => {
    const [entry] = normalizeReview({ items: [{
      memory: item('n', 'A'), conflicts: [item('o', 'B')], suggested_resolution: { action: 'keep_both' },
    }] })
    expect(entry?.conflicts.map((c) => c.memory_id)).toStrictEqual(['o'])
    expect(entry?.suggested_resolution?.action).toBe('keep_both')
  })
})

describe('resolveRequest', () => {
  const memory = { memory_id: 'new' }
  const other = { memory_id: 'old' }

  it('sends keep with the reviewed item as winner for "Keep this one"', () => {
    expect(resolveRequest('keep', memory, other, '')).toStrictEqual({ action: 'keep', winner_id: 'new' })
  })

  it('sends keep with the OTHER item as winner for "Keep the existing one" — never the server\'s replace', () => {
    expect(resolveRequest('replace', memory, other, '')).toStrictEqual({ action: 'keep', winner_id: 'old' })
  })

  it('sends merge with the trimmed statement and keep_both bare', () => {
    expect(resolveRequest('merge', memory, other, '  One statement ')).toStrictEqual({ action: 'merge', statement: 'One statement' })
    expect(resolveRequest('keep_both', memory, other, '')).toStrictEqual({ action: 'keep_both' })
  })
})
