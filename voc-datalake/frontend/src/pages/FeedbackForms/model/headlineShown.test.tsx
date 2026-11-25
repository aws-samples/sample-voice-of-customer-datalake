/**
 * A question named by its headline shows each recall placeholder as `[id]` (Q5, 7.71.03; docs/feedback-forms.md
 * "Recall"), never as written nor a respondent's value: Results' drop-off and Reach, the logic targets, an update's
 * removal warning and a stale save's differences, the AI's change rows, a choice's routing, the texts to translate and
 * the assistant's draft. So does an ending named by its title (F7, 7.71.04): those places, a rule's "anyway" note and
 * a problem's place too.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import i18n from 'i18next'
import { render } from '../../../test/test-utils'
import { defined } from '../../../test/defined'
import { parseFormResults } from '../../../api/feedbackFormsV2Results'
import { EndingsAndFields, QuestionRows } from '../../../assistant/approvals/previews/FeedbackFormDraftParts'
import { conflictDifferences, removedParts } from '../builder/draftChanges'
import { problemPlace } from '../builder/problemText'
import { applyLabel, headlineOf } from '../ai/changeText'
import { fallthroughLabel, targetGroups } from '../logic/ruleControls'
import { targetText } from '../logic/ruleSentence'
import ChoiceRouting from '../questions/ChoiceRouting'
import { FunnelCard, ReachCard } from '../results/FunnelCard'
import { RESULTS } from '../results/results-fixtures'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import TranslationTable from '../tabs/TranslationTable'
import type { ChoiceQuestion, FormV2 } from './formsV2'
import { headlineShown } from './recall'
import { ruleProblems } from './ruleProblems'

const t = i18n.getFixedT('en', 'feedbackForms')

const PICK: ChoiceQuestion = {
  id: 'q_why', type: 'single_select', headline: { en: 'Why did you join {{ event | the workshop }}?' }, required: true,
  options: [{ code: 'learn', label: { en: 'To learn' } }], other: { enabled: false }, none: { enabled: false },
  shuffle: 'none', display: 'list',
}
const FEEDBACK = defined(sampleForm().questions[0], 'q_feedback')
/** The default ending, its title recalling the `event` hidden field, then one recalling nothing. */
const THANKS = { id: 'end_thanks', title: { en: 'Thanks for {{ event | coming }}!' } }
const BYE = { id: 'end_bye', title: { en: 'Bye' } }
/** The sample question, then a choice whose headline recalls the `event` hidden field; the two endings. */
const FORM: FormV2 = sampleForm({ questions: [FEEDBACK, PICK], hidden_fields: [{ id: 'event' }], endings: [THANKS, BYE] })
const SHOWN = 'Why did you join [event]?'
const ENDING = 'Thanks for [event]!'

describe('headlineShown', () => {
  it("reads a headline or an ending's title in a language with each placeholder as [id], and '' for none", () => {
    expect(headlineShown(PICK.headline, 'en')).toBe(SHOWN)
    expect(headlineShown(THANKS.title, 'en')).toBe(ENDING)
    expect(headlineShown(PICK.headline, 'pl')).toBe('')
    expect(headlineShown(undefined, 'en')).toBe('')
  })
})

describe('a recalling headline or ending title where the builder names its question or ending', () => {
  it('reads [id] in the logic targets and the Otherwise entry', () => {
    expect(targetGroups(t, FORM, 0, null).next).toStrictEqual([{ value: 'q_why', label: `2 · ${SHOWN}` }])
    expect(fallthroughLabel(t, FORM, 0)).toBe(`Next question: 2 · ${SHOWN}`)
    expect(targetText(t, FORM, 'q_why')).toBe(`2 · ${SHOWN}`)
  })

  it("reads [id] in an ending as a logic target, the last question's Otherwise entry and a rule's \"anyway\" note", () => {
    const routed: FormV2 = { ...FORM, questions: [FEEDBACK, { ...PICK, logic: [{ when: { op: 'equals', value: 'learn' }, then: { jump_to: 'end_thanks' } }] }] }
    expect(targetGroups(t, FORM, 0, null).endings.map((option) => option.label)).toStrictEqual([`Ending: ${ENDING}`, 'Ending: Bye'])
    expect(fallthroughLabel(t, FORM, 1)).toBe(`End: ${ENDING}`)
    expect(targetText(t, FORM, 'end_thanks')).toBe(`Ending: ${ENDING}`)
    expect(ruleProblems(routed, 1)).toContainEqual(expect.objectContaining({ code: 'whereAnywayEnding', params: { title: ENDING } }))
  })

  it("reads [id] in an update's removal warning and a stale save's differences", () => {
    const without = { ...FORM, questions: [FEEDBACK], endings: [BYE] }
    expect(removedParts(t, FORM, without)).toStrictEqual([`question “${SHOWN}”`, `ending “${ENDING}”`])
    expect(conflictDifferences(t, FORM, without).map((difference) => difference.label)).toStrictEqual(expect.arrayContaining([`2 · ${SHOWN}`, `Ending: ${ENDING}`]))
  })

  it("reads [id] in the AI's change rows and an ending's checkbox", () => {
    const change = { key: 'question:q_why', area: 'question', kind: 'changed', id: 'q_why', fields: [], addresses: [] } as const
    const ending = { ...change, key: 'ending:end_thanks', area: 'ending', id: 'end_thanks' } as const
    expect(headlineOf(t, change, FORM, FORM)).toBe(SHOWN)
    expect(headlineOf(t, ending, FORM, FORM)).toBe(ENDING)
    expect(applyLabel(t, ending, FORM, FORM)).toBe(`Apply: Changed ending “${ENDING}”`)
  })

  it("reads [id] in an ending's problem's place", () => {
    expect(problemPlace(t, FORM, { kind: 'ending', id: 'end_thanks', field: 'description' })).toBe(`Ending “${ENDING}”`)
  })

  it("reads [id] in a choice's routing, among the later questions and the endings it can go to", () => {
    const recall = { ...PICK, id: 'q_more', headline: { en: 'More on {{event}}?' } }
    render(<ChoiceRouting form={{ ...FORM, questions: [FEEDBACK, PICK, recall] }} question={PICK} index={1} categories={[]}
      onChange={vi.fn()} onEditLogic={vi.fn()} />)
    expect(screen.getAllByRole('option', { name: '3 · More on [event]?' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('option', { name: `Ending: ${ENDING}` }).length).toBeGreaterThan(0)
  })

  it("reads [id] in the headings of a question's and an ending's texts to translate", () => {
    renderWithDraft(<TranslationTable language="de" />, { ...FORM, languages: ['en', 'de'] })
    expect(screen.getByRole('heading', { name: `2 · ${SHOWN}` })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: ENDING })).toBeInTheDocument()
  })

  it("reads [id] in the assistant's draft of a form, its questions and its endings", () => {
    render(<><QuestionRows form={FORM} onLeaveOut={vi.fn()} /><EndingsAndFields form={FORM} /></>)
    expect(screen.getByTestId('draft-question-2')).toHaveTextContent(SHOWN)
    expect(screen.getByRole('list', { name: 'Endings' })).toHaveTextContent(ENDING)
  })
})

describe('a recalling headline in Results', () => {
  const funnel = { opened: 20, started: 12, steps: [{ question_id: 'q_feedback', reached: 12 }, { question_id: 'q_why', reached: 10 }], completed: 8 }
  const results = parseFormResults({
    ...RESULTS, questions: { q_feedback: { answered: 10, skipped: 0, not_shown: 0 }, q_why: { answered: 8, skipped: 2, not_shown: 0 } }, funnel,
  })

  it('reads [id] in the drop-off', () => {
    render(<FunnelCard form={FORM} funnel={funnel} results={results} />)
    expect(within(screen.getByRole('region', { name: 'Drop-off' })).getByText(`2 · ${SHOWN}`)).toBeInTheDocument()
  })

  it('reads [id] in Reach', () => {
    render(<ReachCard form={FORM} results={results} />)
    expect(within(screen.getByRole('region', { name: 'Reach' })).getByText(`2 · ${SHOWN}`)).toBeInTheDocument()
  })
})
