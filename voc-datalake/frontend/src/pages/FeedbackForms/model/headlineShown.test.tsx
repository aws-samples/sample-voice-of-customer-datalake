/**
 * A question named by its headline shows each recall placeholder as `[id]` (Q5, 7.71.03; docs/feedback-forms.md
 * "Recall"), never as written nor a respondent's value: Results' drop-off and Reach, the logic targets, an update's
 * removal warning and a stale save's differences, the AI's change rows, a choice's routing, the texts to translate and
 * the assistant's draft.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import i18n from 'i18next'
import { render } from '../../../test/test-utils'
import { defined } from '../../../test/defined'
import { parseFormResults } from '../../../api/feedbackFormsV2Results'
import { QuestionRows } from '../../../assistant/approvals/previews/FeedbackFormDraftParts'
import { conflictDifferences, removedParts } from '../builder/draftChanges'
import { headlineOf } from '../ai/changeText'
import { fallthroughLabel, targetGroups } from '../logic/ruleControls'
import { targetText } from '../logic/ruleSentence'
import ChoiceRouting from '../questions/ChoiceRouting'
import { FunnelCard, ReachCard } from '../results/FunnelCard'
import { RESULTS } from '../results/results-fixtures'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import TranslationTable from '../tabs/TranslationTable'
import type { ChoiceQuestion, FormV2 } from './formsV2'
import { headlineShown } from './recall'

const t = i18n.getFixedT('en', 'feedbackForms')

const PICK: ChoiceQuestion = {
  id: 'q_why', type: 'single_select', headline: { en: 'Why did you join {{ event | the workshop }}?' }, required: true,
  options: [{ code: 'learn', label: { en: 'To learn' } }], other: { enabled: false }, none: { enabled: false },
  shuffle: 'none', display: 'list',
}
const FEEDBACK = defined(sampleForm().questions[0], 'q_feedback')
/** The sample question, then a choice whose headline recalls the `event` hidden field. */
const FORM: FormV2 = sampleForm({ questions: [FEEDBACK, PICK], hidden_fields: [{ id: 'event' }] })
const SHOWN = 'Why did you join [event]?'

describe('headlineShown', () => {
  it("reads a question's headline in a language with each placeholder as [id], and '' for none", () => {
    expect(headlineShown(PICK, 'en')).toBe(SHOWN)
    expect(headlineShown(PICK, 'pl')).toBe('')
    expect(headlineShown(undefined, 'en')).toBe('')
  })
})

describe('a recalling headline where the builder names its question', () => {
  it('reads [id] in the logic targets and the Otherwise entry', () => {
    expect(targetGroups(t, FORM, 0, null).next).toStrictEqual([{ value: 'q_why', label: `2 · ${SHOWN}` }])
    expect(fallthroughLabel(t, FORM, 0)).toBe(`Next question: 2 · ${SHOWN}`)
    expect(targetText(t, FORM, 'q_why')).toBe(`2 · ${SHOWN}`)
  })

  it("reads [id] in an update's removal warning and a stale save's differences", () => {
    const without = { ...FORM, questions: [FEEDBACK] }
    expect(removedParts(t, FORM, without)).toStrictEqual([`question “${SHOWN}”`])
    expect(conflictDifferences(t, FORM, without).map((difference) => difference.label)).toContain(`2 · ${SHOWN}`)
  })

  it("reads [id] in the AI's change row", () => {
    const change = { key: 'question:q_why', area: 'question', kind: 'changed', id: 'q_why', fields: [], addresses: [] } as const
    expect(headlineOf(t, change, FORM, FORM)).toBe(SHOWN)
  })

  it("reads [id] in a choice's routing, among the later questions it can go to", () => {
    const recall = { ...PICK, id: 'q_more', headline: { en: 'More on {{event}}?' } }
    render(<ChoiceRouting form={{ ...FORM, questions: [FEEDBACK, PICK, recall] }} question={PICK} index={1} categories={[]}
      onChange={vi.fn()} onEditLogic={vi.fn()} />)
    expect(screen.getAllByRole('option', { name: '3 · More on [event]?' }).length).toBeGreaterThan(0)
  })

  it("reads [id] in the heading of the question's texts to translate", () => {
    renderWithDraft(<TranslationTable language="de" />, { ...FORM, languages: ['en', 'de'] })
    expect(screen.getByRole('heading', { name: `2 · ${SHOWN}` })).toBeInTheDocument()
  })

  it("reads [id] in the assistant's draft of a form", () => {
    render(<QuestionRows form={FORM} onLeaveOut={vi.fn()} />)
    expect(screen.getByTestId('draft-question-2')).toHaveTextContent(SHOWN)
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
