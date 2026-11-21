/**
 * @fileoverview Skip rates on Results › Summary (7.63.00): each question's skipped of those asked, and the cards in
 * form order or the most skipped first.
 *
 * @module pages/FeedbackForms/results/skipRates
 */
import type { FormResults, QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { FormV2, Question } from '../model/formsV2'

/** Skipped of those asked (answered or skipped), in percent; null for a question nobody was asked. */
export function skipRate(aggregate: QuestionAggregate): number | null {
  const asked = aggregate.answered + aggregate.skipped
  return asked === 0 ? null : (aggregate.skipped / asked) * 100
}

export type CardOrder = 'form' | 'skipped'

/** The question cards with their numbers: in form order, or the most skipped first (form order on a tie; a question
 * nobody was asked, and a statement, which takes no answer to skip, last). */
export function orderedCards(form: FormV2, results: FormResults, order: CardOrder): { question: Question; number: number }[] {
  const cards = form.questions.map((question, index) => ({ question, number: index + 1 }))
  if (order === 'form') return cards
  const rate = (question: Question) => {
    const aggregate = results.questions[question.id]
    // (a statement is shown, never answered: the server counts every showing as a skip)
    if (question.type === 'statement' || aggregate === undefined) return -1
    return skipRate(aggregate) ?? -1
  }
  return [...cards].sort((a, b) => rate(b.question) - rate(a.question) || a.number - b.number)
}
