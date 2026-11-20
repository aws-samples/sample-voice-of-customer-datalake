import { describe, expect, it } from 'vitest'
import type { FormV2, Question, RatingQuestion } from './formsV2'
import { unsetFormFields } from './defaults'
import { canAskWhy, lowScoreThreshold, withAskWhy } from './askWhy'
import { blockingProblems, validateForm } from './validateForm'
import { formPaths } from './paths'

const rating = (range: RatingQuestion['range'], extra: Partial<RatingQuestion> = {}): RatingQuestion =>
  ({ id: 'q_tooling', type: 'rating', headline: { en: 'Tooling' }, required: true, scale: 'number', range, ...extra })

function formOf(questions: readonly Question[]): FormV2 {
  return {
    schema_version: 2, name: 'Workshop', enabled: false, language: 'en', languages: ['en'], welcome: { enabled: false, title: {} },
    questions, hidden_fields: [], endings: [{ id: 'end_thanks', title: { en: 'Thanks' } }], ...unsetFormFields(),
  }
}

const next: Question = { id: 'q_next', type: 'open_text', headline: { en: 'Next' }, required: false, long: true, input_type: 'text' }
const headline = (placeholder: string) => `What's the main reason for your score of ${placeholder}?`

const RANGES: readonly RatingQuestion['range'][] = [3, 4, 5, 7, 10]

describe('the low score of each scale', () => {
  it('is NPS 6, CSAT and CES 3, and a rating 2 of 5 scaled for its points', () => {
    expect((['nps', 'csat', 'ces'] as const).map((type) => lowScoreThreshold({ id: 'q_s', type, headline: {}, required: true })))
      .toStrictEqual([6, 3, 3])
    expect(RANGES.map((range) => lowScoreThreshold(rating(range)))).toStrictEqual([1, 2, 2, 3, 4])
  })
})

describe('Ask why when the score is low', () => {
  it('inserts an optional follow-up recalling the score, which a high score jumps past', () => {
    const made = withAskWhy(formOf([rating(5), next]), 'q_tooling', headline)
    const [score, followUp, after] = made?.questions ?? []
    expect([followUp?.id, after?.id, followUp?.logic]).toStrictEqual(['q_tooling_why', 'q_next', undefined])
    expect(score?.logic).toStrictEqual([{ when: { op: 'gt', value: 2 }, then: { jump_to: 'q_next' } }])
    expect(followUp).toMatchObject({ id: 'q_tooling_why', type: 'open_text', required: false,
      headline: { en: "What's the main reason for your score of {{q_tooling}}?" } })
  })

  it('makes a form with no blocking problem and two ways through', () => {
    const made = withAskWhy(formOf([rating(5), next]), 'q_tooling', headline)
    expect(made === null ? ['missing'] : blockingProblems(validateForm(made))).toStrictEqual([])
    expect(made === null ? 0 : formPaths(made).total).toBeGreaterThan(1)
  })

  it('sends a skip past it too on an optional score, and the last question on to the first ending', () => {
    const made = withAskWhy(formOf([rating(10, { required: false })]), 'q_tooling', headline)
    expect(made?.questions[0]?.logic).toStrictEqual([
      { when: { op: 'gt', value: 4 }, then: { jump_to: 'end_thanks' } }, { when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } },
    ])
  })

  it("keeps the score's Otherwise as the follow-up's, and never takes a removed question's id", () => {
    const routed = rating(5, { logic: [{ when: { op: 'submitted' }, then: { jump_to: 'end_thanks' } }] })
    const made = withAskWhy(formOf([routed, next]), 'q_tooling', headline, new Set(['q_tooling_why']))
    expect(made?.questions[1]?.id).toBe('q_tooling_why_2')
    expect(made?.questions[0]?.logic).toStrictEqual([{ when: { op: 'gt', value: 2 }, then: { jump_to: 'end_thanks' } }])
    expect(made?.questions[1]?.logic).toStrictEqual([{ when: { op: 'submitted' }, then: { jump_to: 'end_thanks' } },
      { when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } }])
  })

  it('is offered on a scale with no rules of its own only', () => {
    const ruled = rating(5, { logic: [{ when: { op: 'lte', value: 2 }, then: { jump_to: 'q_next' } }] })
    expect([canAskWhy(rating(5)), canAskWhy(ruled), canAskWhy(next)]).toStrictEqual([true, false, false])
    expect(withAskWhy(formOf([ruled, next]), 'q_tooling', headline)).toBeNull()
    expect(withAskWhy(formOf([next]), 'q_missing', headline)).toBeNull()
  })
})
