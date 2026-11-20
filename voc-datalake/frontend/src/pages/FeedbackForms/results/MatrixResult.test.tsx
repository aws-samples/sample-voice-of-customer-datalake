/**
 * A matrix question's results (7.61.00): one chart per row in the question's order (a bar per column with its count
 * and share), the row's average score when the columns are scored, rows and columns the revision no longer has noted,
 * and its headline's recall placeholder shown as `[id]` on its card.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { render } from '../../../test/test-utils'
import type { QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { MatrixQuestion } from '../model/formsV2'
import { PHASES, RESULTS_FORM } from './results-fixtures'
import MatrixResult from './MatrixResult'
import QuestionResultCard from './QuestionResultCard'

const FIGURES: QuestionAggregate = {
  answered: 10, skipped: 0, not_shown: 0,
  matrix: {
    rows: [
      { code: 'intro', answered: 10, counts: { poor: 2, ok: 5, great: 3, top: 0 }, average: 2.1 },
      { code: 'lab', answered: 8, counts: { poor: 0, ok: 0, great: 4, top: 4 }, average: 3.5 },
    ],
    scored: true, removed_rows: {}, removed_columns: {},
  },
}

function renderMatrix(question: MatrixQuestion, aggregate: QuestionAggregate) {
  render(<MatrixResult question={question} aggregate={aggregate} language="en" />)
  return screen.getByRole('list', { name: 'Answers by row' })
}

describe('MatrixResult', () => {
  it('charts each row over the columns, with its count and share of those who rated it', () => {
    renderMatrix(PHASES, FIGURES)
    const lab = screen.getByRole('list', { name: 'Answers for Hands-on lab' })
    expect(within(lab).getAllByRole('listitem').map((item) => item.textContent))
      .toStrictEqual(['Needs improvement0 · 0%', 'Satisfactory0 · 0%', 'Very effective4 · 50%', 'Exceptional4 · 50%'])
    expect(screen.getByRole('heading', { name: 'Introduction' })).toBeInTheDocument()
  })

  it("gives each row its average score on the columns' scale", () => {
    const rows = renderMatrix(PHASES, FIGURES)
    expect(rows).toHaveTextContent('Rated by 10 · average 2.1 (scores 1 to 4)')
    expect(rows).toHaveTextContent('Rated by 8 · average 3.5 (scores 1 to 4)')
  })

  it('gives no average when no column has a score, and a row nobody rated its zeros', () => {
    const unscored: MatrixQuestion = { ...PHASES, columns: PHASES.columns.map(({ code, label }) => ({ code, label })) }
    const figures: QuestionAggregate = { ...FIGURES, matrix: { rows: [], scored: false, removed_rows: {}, removed_columns: {} } }
    const rows = renderMatrix(unscored, figures)
    expect(rows).not.toHaveTextContent('average')
    expect(within(screen.getByRole('list', { name: 'Answers for Introduction' })).getAllByRole('listitem').map((item) => item.textContent))
      .toStrictEqual(['Needs improvement0 · 0%', 'Satisfactory0 · 0%', 'Very effective0 · 0%', 'Exceptional0 · 0%'])
  })

  it('notes the answers to rows and columns the question no longer has', () => {
    const matrix = FIGURES.matrix ?? { rows: [], scored: false, removed_rows: {}, removed_columns: {} }
    renderMatrix(PHASES, { ...FIGURES, matrix: { ...matrix, removed_rows: { demo: 3 }, removed_columns: { meh: 1 } } })
    expect(screen.getByRole('list', { name: 'Answers to removed rows and columns' }).textContent)
      .toBe('Row demo (removed): 3 answersColumn meh (removed): 1 answer')
  })

  it('is the card of a matrix question, its recalled value shown as its id', () => {
    render(<QuestionResultCard form={RESULTS_FORM} question={PHASES} number={2} aggregate={FIGURES} removed={{}} funnel={null} onShowAll={vi.fn<() => void>()} />)
    const card = screen.getByRole('region', { name: '2 · How was each part of [event]?' })
    expect(within(card).getByRole('list', { name: 'Answers by row' })).toBeInTheDocument()
  })
})
