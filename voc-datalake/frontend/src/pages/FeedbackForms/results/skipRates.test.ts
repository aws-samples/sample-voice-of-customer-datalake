import { describe, expect, it } from 'vitest'
import { parseFormResults } from '../../../api/feedbackFormsV2Results'
import { orderedCards, skipRate } from './skipRates'
import { blankForm } from '../test/blankForm'
import { newQuestion } from '../model/defaults'
import type { FormV2 } from '../model/formsV2'

const open = (id: string) => ({ id, type: 'open_text' as const, headline: { en: id }, required: false, long: true, input_type: 'text' as const })
const FORM: FormV2 = { ...blankForm('en'), questions: [open('q_a'), open('q_b'), open('q_c'), open('q_d')] }

describe('skip rates', () => {
  it('are skipped of those asked, none for a question nobody was asked', () => {
    expect(skipRate({ answered: 6, skipped: 2, not_shown: 9 })).toBe(25)
    expect(skipRate({ answered: 0, skipped: 0, not_shown: 9 })).toBeNull()
  })

  it('order the cards most skipped first, form order on a tie and the unasked last', () => {
    const results = parseFormResults({ questions: {
      q_a: { answered: 9, skipped: 1, not_shown: 0 }, q_b: { answered: 5, skipped: 5, not_shown: 0 },
      q_c: { answered: 0, skipped: 0, not_shown: 10 }, q_d: { answered: 9, skipped: 1, not_shown: 0 },
    } })
    expect(orderedCards(FORM, results, 'skipped').map((card) => [card.question.id, card.number])).toStrictEqual([
      ['q_b', 2], ['q_a', 1], ['q_d', 4], ['q_c', 3],
    ])
    expect(orderedCards(FORM, results, 'form').map((card) => card.question.id)).toStrictEqual(['q_a', 'q_b', 'q_c', 'q_d'])
  })

  it('rank a statement last: shown to all, answered by none, it is no skip', () => {
    const form: FormV2 = { ...FORM, questions: [newQuestion('statement', 'q_note'), open('q_a'), open('q_b')] }
    const results = parseFormResults({ questions: {
      q_note: { answered: 0, skipped: 10, not_shown: 0 }, q_a: { answered: 9, skipped: 1, not_shown: 0 },
      q_b: { answered: 0, skipped: 0, not_shown: 10 },
    } })
    expect(orderedCards(form, results, 'skipped').map((card) => card.question.id)).toStrictEqual(['q_a', 'q_note', 'q_b'])
  })
})
