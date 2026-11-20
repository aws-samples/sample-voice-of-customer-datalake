/**
 * One response's sheet and summary with a matrix question (7.61.00): its answer as "Row: Column" per rated row, in
 * the question's order, by labels (a row or a column it no longer has by its code), and a headline that recalls a
 * value shown with its placeholder as `[id]`.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import i18n from 'i18next'
import { render } from '../../../test/test-utils'
import type { FormResponse } from '../../../api/feedbackFormsV2Results'
import type { FormV2 } from '../model/formsV2'
import { PHASES, RESULTS_FORM } from './results-fixtures'
import { answerText, matrixLines } from './answers'
import ResponseSheet from './ResponseSheet'

const FORM: FormV2 = { ...RESULTS_FORM, questions: [PHASES, ...RESULTS_FORM.questions] }
const RESPONSE: FormResponse = {
  response_id: 'r_1', submitted_at: '2026-11-17T14:02:00Z', form_revision: 2, language: 'en',
  answers: { q_phases: { rows: { lab: 'top', intro: 'ok', demo: 'great', qa: 'meh' } }, q_nps: 9 },
  hidden: { event: 'Lisbon' }, ending_id: 'end_thanks', is_test: false,
}

describe('a matrix answer', () => {
  it('reads as "Row: Column" in row order, then the rows the question no longer has', () => {
    expect(matrixLines(FORM, PHASES, { lab: 'top', intro: 'ok', demo: 'great', qa: 'meh' }))
      .toStrictEqual(['Introduction: Satisfactory', 'Hands-on lab: Exceptional', 'demo: Very effective', 'qa: meh'])
  })

  it("is one line in the table's summary", () => {
    expect(answerText(i18n.getFixedT('en', 'feedbackForms'), FORM, PHASES, { rows: { intro: 'poor' } })).toBe('Introduction: Needs improvement')
  })

  it('is a line per row in the sheet, under its headline with the recalled value as its id', () => {
    render(<ResponseSheet form={FORM} response={RESPONSE} onClose={vi.fn<() => void>()} />)
    const answers = screen.getByRole('list', { name: 'Answers' })
    const item = within(answers).getByText('1 · How was each part of [event]?').closest('li')
    expect(item?.querySelectorAll('ul li')).toHaveLength(4)
    expect(item).toHaveTextContent('Introduction: SatisfactoryHands-on lab: Exceptional')
  })
})
