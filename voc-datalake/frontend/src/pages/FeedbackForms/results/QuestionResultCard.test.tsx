/**
 * One question's card on Results › Summary (UX §10.2): the reach line every card carries, the badge of options changed
 * while live, and the figures of an open text, a consent, a contact and a statement question.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/test-utils'
import type { FormFunnel, QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { Question } from '../model/formsV2'
import { newQuestion } from '../model/defaults'
import { RESULTS, RESULTS_FORM } from './results-fixtures'
import QuestionResultCard from './QuestionResultCard'

const reach = (answered: number, skipped = 0): QuestionAggregate => ({ answered, skipped, not_shown: 0 })

function renderCard(question: Question, aggregate: QuestionAggregate | undefined, funnel: FormFunnel | null = null) {
  const onShowAll = vi.fn<() => void>()
  const headed = { ...question, headline: { en: 'The question' } }
  render(<QuestionResultCard form={RESULTS_FORM} question={headed} number={4} aggregate={aggregate} removed={{}} funnel={funnel} onShowAll={onShowAll} />)
  return { user: userEvent.setup(), onShowAll, card: screen.getByRole('region', { name: '4 · The question' }) }
}

describe('QuestionResultCard: open text', () => {
  const comment = newQuestion('open_text', 'q_comment')
  const latest = { ...RESULTS.questions.q_comment, latest: [...RESULTS.questions.q_comment.latest, { text: 'Testing', is_test: true }] }

  it('lists the latest answers, a test one marked, each with the way to its feedback', () => {
    const { card } = renderCard(comment, latest)
    expect(within(card).getAllByRole('listitem')).toHaveLength(3)
    expect(within(card).getByText('Test').closest('li')).toHaveTextContent('“Testing”')
    expect(within(card).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/feedback/fb_1')
  })

  it('searches the answers, and says when none matches', async () => {
    const { user, card } = renderCard(comment, latest)
    const search = within(card).getByRole('searchbox', { name: 'Search answers…' })
    await user.type(search, 'EXPORT')
    expect(within(card).getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual([expect.stringContaining('The export is gone')])
    await user.type(search, ' and more')
    expect(within(card).getByText('No answer matches.')).toBeInTheDocument()
  })

  it('says there are no answers yet, and opens all of them in Responses', async () => {
    const { user, card, onShowAll } = renderCard(comment, { ...reach(3), latest: [] })
    expect(within(card).getByText('No answers yet.')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Show all 3 in Responses' }))
    expect(onShowAll).toHaveBeenCalledTimes(1)
  })
})

describe('QuestionResultCard: the reach line and the change badge', () => {
  it('reads zeros for a question no one has reached yet', () => {
    const { card } = renderCard(newQuestion('nps', 'q_nps'), undefined)
    expect(within(card).getByText('Answered 0 · Skipped 0 · Not shown 0 (logic)')).toBeInTheDocument()
  })

  it('says when the options changed while live', () => {
    const { card } = renderCard(newQuestion('multi_select', 'q_why'), { ...reach(3), counts: {}, changed_at: '2026-11-10T10:00:00Z' })
    expect(within(card).getByText(/^Changed .+: answers before then used other options$/)).toBeInTheDocument()
  })
})

describe('QuestionResultCard: consent, contact and statement', () => {
  it('says how many accepted a consent of those who saw it', () => {
    const { card } = renderCard(newQuestion('consent', 'q_ok'), { ...reach(8, 2), accepted: 6 })
    expect(within(card).getByText('Accepted by 6 of 10 who saw it (60%).')).toBeInTheDocument()
  })

  it('counts the contact details left, with the emails and phone numbers when the server counted them', () => {
    const { card } = renderCard(newQuestion('contact_info', 'q_contact'), { ...reach(4), contact: { left: 4, emails: 3, phones: 1 } })
    expect(within(card).getByText('4 left contact details · 3 emails · 1 phone numbers')).toBeInTheDocument()
    expect(within(card).getByText('The details themselves are in Responses.')).toBeInTheDocument()
  })

  it('counts the people who left contact details when only that is known', () => {
    const { card } = renderCard(newQuestion('contact_info', 'q_contact'), reach(5))
    expect(within(card).getByText('5 people left contact details')).toBeInTheDocument()
  })

  it('says how many people a statement was shown to, from the drop-off steps', () => {
    const funnel: FormFunnel = { opened: 20, started: 15, steps: [{ question_id: 'q_note', reached: 12 }], completed: 9 }
    const { card } = renderCard(newQuestion('statement', 'q_note'), reach(0), funnel)
    expect(within(card).getByText('Shown to 12 people.')).toBeInTheDocument()
  })

  it('has no answer to show for a statement without the drop-off steps', () => {
    const { card } = renderCard(newQuestion('statement', 'q_note'), reach(0))
    expect(within(card).getByText('No answer to show.')).toBeInTheDocument()
  })
})
