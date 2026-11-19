/**
 * The drop-off funnel with logic (audit §3.4 Results): a question only some paths show is shown to fewer people BY
 * DESIGN, so it never carries a drop nor "largest drop"; a drop is measured only between steps every path passes.
 */
import { describe, expect, it } from 'vitest'
import type { FormFunnel, FormResults } from '../../../api/feedbackFormsV2Results'
import type { FormV2, Question } from '../model/formsV2'
import { newQuestion } from '../model/defaults'
import { blankForm } from '../test/blankForm'
import { everyPathQuestions, funnelSteps, largestDrop } from './funnelSteps'

const open = (id: string): Question => ({ ...newQuestion('open_text', id), headline: { en: id } })

/** q_a → (answer "missing") q_b → q_c, else (Otherwise) straight to q_c: q_b is on one path of two. */
function branching(): FormV2 {
  const choice: Question = {
    ...newQuestion('single_select', 'q_a'), headline: { en: 'Why?' },
    logic: [
      { when: { op: 'equals', value: 'missing' }, then: { jump_to: 'q_b' } },
      { when: { op: 'submitted' }, then: { jump_to: 'q_c' } },
    ],
  }
  return { ...blankForm('en'), questions: [choice, open('q_b'), open('q_c')] }
}

const reach = (answered: number, skipped = 0, notShown = 0) => ({ answered, skipped, not_shown: notShown })

/** Ten completed responses: three took q_b. Fifty opened; 5 left at q_a, 5 at q_b, 10 at q_c (the adapter's reached). */
const RESULTS: FormResults = {
  total: 10, test_count: 0, last_response_at: null,
  questions: { q_a: reach(10), q_b: reach(3, 0, 7), q_c: reach(10) },
  endings: {}, removed_questions: [], removed_options: {}, funnel: null,
}
const FUNNEL: FormFunnel = {
  opened: 50, started: 30,
  steps: [{ question_id: 'q_a', reached: 30 }, { question_id: 'q_b', reached: 25 }, { question_id: 'q_c', reached: 20 }],
  completed: 10,
}

describe('everyPathQuestions', () => {
  it('keeps the questions every path passes, not the one only a rule leads to', () => {
    expect([...everyPathQuestions(branching())]).toStrictEqual(['q_a', 'q_c'])
  })

  it('is every question of a form without logic', () => {
    const form = { ...blankForm('en'), questions: [open('q_1'), open('q_2'), open('q_3')] }
    expect([...everyPathQuestions(form)]).toStrictEqual(['q_1', 'q_2', 'q_3'])
  })

  it('counts the question two branches rejoin at as on every path, and neither branch', () => {
    // q_a → q_b → q_d (q_b jumps past q_c, answered or skipped) or q_a → q_c → q_d: two paths, both through q_d.
    const [choice] = branching().questions
    const toD: Question = {
      ...open('q_b'),
      logic: [{ when: { op: 'submitted' }, then: { jump_to: 'q_d' } }, { when: { op: 'skipped' }, then: { jump_to: 'q_d' } }],
    }
    const rejoin = { ...blankForm('en'), questions: [choice ?? open('q_a'), toD, open('q_c'), open('q_d')] }
    expect([...everyPathQuestions(rejoin)]).toStrictEqual(['q_a', 'q_d'])
  })
})

describe('funnelSteps', () => {
  it('never puts the drop or "largest drop" on a question only some paths show', () => {
    const steps = funnelSteps(branching(), FUNNEL, RESULTS)
    const byKey = Object.fromEntries(steps.map((step) => [step.key, step]))
    // (q_b's count is who saw it: 3 completed responses and the 5 who left at it, not "25 reached")
    expect(byKey['q_b']).toMatchObject({ everyPath: false, count: 8, dropPercent: null, dropped: 0 })
    // q_c is measured from q_a, the every-path step before it: 30 → 20
    expect(byKey['q_c']).toMatchObject({ everyPath: true, count: 20, dropped: 10 })
    expect(byKey['q_c']?.dropPercent).toBeCloseTo(33.33, 1)
    // The naive reading (every step against the one before) called q_b the largest drop: 30 → 25 → …
    expect(steps[largestDrop(steps) ?? -1]?.key).not.toBe('q_b')
  })

  it('marks the step that lost the most people among the steps every path passes', () => {
    const steps = funnelSteps(branching(), FUNNEL, RESULTS)
    // opened 50 → started 30 (20), q_a 30 (0), q_c 20 (10), completed 10 (10)
    expect(steps[largestDrop(steps) ?? -1]?.key).toBe('started')
    expect(steps.map((step) => step.number)).toStrictEqual([null, null, 1, 2, 3, null])
  })

  it('has no largest drop when nobody was lost', () => {
    const none: FormFunnel = { opened: 10, started: 10, steps: [{ question_id: 'q_feedback', reached: 10 }], completed: 10 }
    expect(largestDrop(funnelSteps(blankForm('en'), none, { ...RESULTS, questions: { q_feedback: reach(10) } }))).toBeNull()
  })
})
