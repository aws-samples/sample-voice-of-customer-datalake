/**
 * @fileoverview parseJsonFeedback: one invalid item no longer blocks the file. The valid
 * items stay importable, each invalid one is reported by its 1-based position with a
 * structured reason (never Zod's raw "Item 1.text: Invalid input: expected string").
 */
import { describe, it, expect } from 'vitest'
import { parseJsonFeedback } from './jsonUploadSchema'

const valid = (id: string) => ({ id, text: 'Great', source: 'zendesk', timestamp: '2026-03-20T14:30:00Z' })

function parse(items: unknown) {
  const result = parseJsonFeedback(JSON.stringify(items))
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join(', ')}`)
  return result
}

describe('parseJsonFeedback', () => {
  it('keeps the valid items and reports the invalid one by its 1-based position', () => {
    const result = parse([valid('a'), { id: 'b', source: 'zendesk', timestamp: '2026-03-20T14:30:00Z' }, valid('c')])

    expect(result.data.map((i) => i.id)).toStrictEqual(['a', 'c'])
    expect(result.skipped.map((s) => [s.position, s.reasons.map((r) => [r.kind, r.field])])).toStrictEqual([[2, [['required', 'text']]]])
  })

  it('lists every missing field of an item at once, either-or pairs by both names', () => {
    const result = parse([{ id: 'x' }])

    expect(result.skipped[0]?.reasons.map((r) => [r.kind, r.field])).toStrictEqual([
      ['required', 'text'],
      ['required', 'timestamp (or created_at)'],
      ['required', 'source (or source_channel)'],
    ])
  })

  it('tells a wrong type from a missing field, and a non-object item from both', () => {
    const result = parse([{ ...valid('a'), text: 42 }, 'just text'])

    expect(result.skipped.map((s) => s.reasons[0]?.kind)).toStrictEqual(['type', 'notObject'])
    expect(result.data).toStrictEqual([])
  })

  it('keeps a bound violation as invalid with its own message', () => {
    const result = parse([{ ...valid('a'), rating: 9 }])

    expect(result.skipped[0]?.reasons[0]).toMatchObject({ kind: 'invalid', field: 'rating' })
  })

  it.each([
    [[], 'File must contain at least one item'],
    [{ nope: true }, 'File must contain a JSON array or an object with an "items" array'],
    [Array.from({ length: 501 }, (_, i) => valid(String(i))), 'Maximum 500 items per upload'],
  ])('still blocks a file whose shape is wrong (%#)', (items, error) => {
    expect(parseJsonFeedback(JSON.stringify(items))).toStrictEqual({ ok: false, errors: [error] })
  })

  it('accepts the items wrapper and the either-or alternates', () => {
    const result = parse({ items: [{ id: 'a', text: 't', source_channel: 'email', created_at: '2026-01-01' }] })

    expect(result).toMatchObject({ data: [{ id: 'a' }], skipped: [] })
  })
})
