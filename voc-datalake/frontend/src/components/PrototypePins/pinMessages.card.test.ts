/**
 * The validation card's messages between the pin widget and its host (7.68.00, pinMessages.ts): the frame is model
 * code, so only a card request or an answer of the card's own shape is forwarded to the public submit route.
 */
import { describe, expect, it } from 'vitest'
import { cardResultMessage, parseWidgetMessage } from './pinMessages'

const FORM_ID = 'pf_0123456789abcdef'
const message = (type: string, body: unknown) => ({ source: 'voc-pin-widget', type, formId: FORM_ID, requestId: 'v1', body })

describe('a card message from the widget', () => {
  it('is taken for a card request and for an answer', () => {
    expect(parseWidgetMessage(message('card', { answers: {} }))?.type).toBe('card')
    const answer = { answers: { q_vt_t1: { code: 'yes' }, q_v_ces: 6, q_v_missing: 'Export' }, form_revision: 2, language: 'en' }
    expect(parseWidgetMessage(message('answer', answer))).toStrictEqual(message('answer', answer))
  })

  it.each([
    ['an unknown field', { answers: {}, test: 'token' }],
    ['an answer of another shape', { answers: { q_x: [1, 2] } }],
    ['a choice with more than its code', { answers: { q_x: { code: 'yes', other: 'x' } } }],
    ['too many answers', { answers: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`q_${i}`, 1])) }],
    ['a revision that is not one', { answers: { q_x: 1 }, form_revision: 0 }],
  ])('is refused with %s', (_label, body) => {
    expect(parseWidgetMessage(message('answer', body))).toBeNull()
  })
})

describe('the host answer', () => {
  it('carries the card for a card request, and only ok for an answer', () => {
    expect(cardResultMessage('card', 'v1', true, { revision: 2 })).toStrictEqual(
      { source: 'voc-pin-host', type: 'card', requestId: 'v1', ok: true, card: { revision: 2 } })
    expect(cardResultMessage('answer', 'v2', false)).toStrictEqual(
      { source: 'voc-pin-host', type: 'answer', requestId: 'v2', ok: false })
  })
})
