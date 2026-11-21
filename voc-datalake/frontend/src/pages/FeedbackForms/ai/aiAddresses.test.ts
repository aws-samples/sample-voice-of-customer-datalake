import { describe, expect, it } from 'vitest'
import type { FormV2, Question } from '../model/formsV2'
import { sampleForm } from '../test/draftHarness'
import { addressAt, draftAddresses, sameLocation, withoutAddress } from './aiAddresses'

const plans: Question = { id: 'q_plans', type: 'statement', headline: { en: 'Our plans' }, required: false, cta: { label: { en: 'See plans' }, url: 'https://example.com/plans' } }
const noLink: Question = { id: 'q_note', type: 'statement', headline: { en: 'A note' }, required: false }

/** An AI draft with a statement's link button, a statement without one, and an ending's button. */
const drafted = (): FormV2 => sampleForm({
  questions: [...sampleForm().questions, plans, noLink],
  endings: [{ id: 'end_thanks', title: { en: 'Thanks' }, button: { label: { en: 'Help' }, url: 'https://example.com/help' } }, { id: 'end_bye', title: { en: 'Bye' } }],
})

const STATEMENT = { kind: 'question', id: 'q_plans', field: 'cta_url' } as const
const ENDING = { kind: 'ending', id: 'end_thanks', field: 'button_url' } as const

describe('the addresses an AI draft suggests', () => {
  it('are every statement\'s link and every ending\'s button that has an address', () => {
    expect(draftAddresses(drafted())).toStrictEqual([STATEMENT, ENDING])
  })

  it('read the address at each place, and none where there is no longer one', () => {
    const form = drafted()
    expect([addressAt(form, STATEMENT), addressAt(form, ENDING)]).toStrictEqual(['https://example.com/plans', 'https://example.com/help'])
    expect([addressAt(form, { kind: 'question', id: 'q_feedback' }), addressAt(form, { kind: 'ending', id: 'end_bye' })]).toStrictEqual(['', ''])
  })

  it('go when removed: a statement keeps its button without the address, an ending loses its button', () => {
    const form = withoutAddress(withoutAddress(drafted(), STATEMENT), ENDING)
    expect(form.questions.find((q) => q.id === 'q_plans')).toStrictEqual({ ...plans, cta: { label: { en: 'See plans' }, url: undefined } })
    expect(form.endings[0]?.button).toBeUndefined()
    expect(draftAddresses(form)).toStrictEqual([])
  })

  it('are the same place only when kind, id and field all match', () => {
    expect(sameLocation(STATEMENT, { kind: 'question', id: 'q_plans', field: 'cta_url' })).toBe(true)
    expect(sameLocation(STATEMENT, { kind: 'question', id: 'q_note', field: 'cta_url' })).toBe(false)
  })
})
