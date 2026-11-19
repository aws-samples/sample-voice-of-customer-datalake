import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FlowTab from './FlowTab'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { templateById, templateForm } from '../formTemplates'
import { catalogueLookup } from '../tabs/languages/languageEdits'
import type { FormV2, Question } from '../model/formsV2'

function churn(): FormV2 {
  const flow = templateById('churn')
  if (flow === undefined) throw new Error('The churn template is missing.')
  return templateForm(flow, 'en', catalogueLookup('en'))
}

const open = (id: string, headline: string, logic?: Question['logic']): Question =>
  ({ id, type: 'open_text', headline: { en: headline }, required: true, long: true, input_type: 'text', logic })

describe('FlowTab: the whole path on one outline', () => {
  it('counts the churn template’s questions, endings and paths, and the shortest and longest path', () => {
    renderWithDraft(<FlowTab />, churn())
    expect(screen.getByTestId('flow-summary')).toHaveTextContent('8 questions · 2 endings · 12 paths · shortest 2, longest 4 questions')
  })

  it('says how many paths reach each ending, and which one is the default', () => {
    renderWithDraft(<FlowTab />, churn())
    const bye = within(screen.getByTestId('flow-end_bye'))
    expect(bye.getByText('reached by 6 paths')).toBeInTheDocument()
    expect(bye.getByText('default')).toBeInTheDocument()
    expect(within(screen.getByTestId('flow-end_contact')).getByText('reached by 6 paths')).toBeInTheDocument()
  })

  it('reads every rule as a sentence, and the Otherwise after them', () => {
    renderWithDraft(<FlowTab />, churn())
    const reason = within(screen.getByTestId('flow-q_reason'))
    expect(reason.getByRole('button', { name: 'If the answer is “It\'s too expensive for me” → 2 · What could have kept you?' })).toBeInTheDocument()
    expect(reason.getByRole('button', { name: 'Otherwise → 7 · Can we follow up with you?' })).toBeInTheDocument()
  })

  it('marks a question no path reaches', () => {
    const form = sampleForm({ questions: [open('q_a', 'First', [{ when: { op: 'submitted' }, then: { jump_to: 'q_c' } }]), open('q_b', 'Second'), open('q_c', 'Third')] })
    renderWithDraft(<FlowTab />, form)
    expect(within(screen.getByTestId('flow-q_b')).getByText('No path reaches this question')).toBeInTheDocument()
    expect(within(screen.getByTestId('flow-q_c')).queryByText('No path reaches this question')).not.toBeInTheDocument()
  })

  it('says everyone goes through in order when no question has a rule', () => {
    renderWithDraft(<FlowTab />, sampleForm())
    expect(screen.getByText(/Everyone goes through the questions in order/)).toBeInTheDocument()
  })

  it('edits a rule in place, and Escape closes it and returns focus to its sentence', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<FlowTab />, churn())
    await user.click(screen.getByRole('button', { name: /If the answer is “It's too expensive for me”/ }))
    expect(screen.getByRole('combobox', { name: 'Rule 1: operator' })).toHaveFocus()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule 1: go to' }), '6 · What went wrong? Anything you remember helps us find it.')
    expect(harness.probe.current?.form.questions[0]?.logic?.[0]?.then.jump_to).toBe('q_technical')
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Rule 1: go to' }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: /If the answer is “It's too expensive for me” → 6/ })).toHaveFocus())
  })
})
