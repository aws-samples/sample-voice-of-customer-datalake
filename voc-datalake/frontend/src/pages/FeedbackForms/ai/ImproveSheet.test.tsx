import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DraftAnswer, DraftRequest } from '../../../api/feedbackFormsV2Api'
import type { FormV2, Question } from '../model/formsV2'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { draftUntilAborted } from '../test/draftUntilAborted'
import ImproveSheet from './ImproveSheet'

const draftForm = vi.hoisted(() => vi.fn<(request: DraftRequest, signal?: AbortSignal) => Promise<DraftAnswer>>())

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...actual, feedbackFormsV2Api: { ...actual.feedbackFormsV2Api, draftForm } }
})

const reason: Question = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why are you cancelling?' }, required: true,
  options: [{ code: 'too_expensive', label: { en: "It's too expensive" } }, { code: 'missing', label: { en: 'Something is missing' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
}
const feature: Question = { id: 'q_feature', type: 'open_text', headline: { en: 'Which feature were you missing?' }, required: false, long: false, input_type: 'text' }
const comment: Question = { id: 'q_comment', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text' }
const price: Question = { id: 'q_price', type: 'open_text', headline: { en: 'What price would feel fair?' }, required: false, long: false, input_type: 'text' }

const current = (): FormV2 => sampleForm({ questions: [reason, feature, comment] })

/** The AI's answer: a follow-up routed from "too expensive", and q_comment removed (three changes). */
const proposal = (): FormV2 => sampleForm({
  questions: [{ ...reason, logic: [{ when: { op: 'equals', value: 'too_expensive' }, then: { jump_to: 'q_price' } }] }, price, feature],
})

async function draftChanges() {
  const user = userEvent.setup()
  const onClose = vi.fn<() => void>()
  const harness = renderWithDraft(<ImproveSheet isOpen onClose={onClose} />, current())
  await user.type(screen.getByRole('textbox', { name: 'Instruction' }), 'Add a price follow-up')
  await user.click(screen.getByRole('button', { name: 'Draft changes' }))
  await screen.findByRole('list', { name: 'Changes from the AI' })
  return { user, harness, onClose }
}

beforeEach(() => {
  draftForm.mockReset()
  draftForm.mockResolvedValue({ form: proposal(), notes: [{ message: 'I added a price follow-up.' }], warnings: [] })
})

describe('ImproveSheet', () => {
  it('shows Stop while the AI drafts, and Stop drafting ends it without a proposal', async () => {
    const signals: AbortSignal[] = []
    draftForm.mockImplementation(draftUntilAborted(signals))
    const user = userEvent.setup()
    renderWithDraft(<ImproveSheet isOpen onClose={vi.fn<() => void>()} />, current())
    await user.type(screen.getByRole('textbox', { name: 'Instruction' }), 'Add a price follow-up')
    await user.click(screen.getByRole('button', { name: 'Draft changes' }))
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Stop drafting' }))
    expect(signals.map((signal) => signal.aborted)).toStrictEqual([true])
    expect(screen.queryByRole('list', { name: 'Changes from the AI' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('asks the AI about the form as it is now, with the instruction', async () => {
    await draftChanges()
    expect(draftForm).toHaveBeenCalledWith(
      { description: 'Add a price follow-up', instruction: 'Add a price follow-up', language: 'en', channel: 'link', base_form: current(), retired_ids: [] },
      expect.any(AbortSignal),
    )
  })

  it('tells the AI the removed questions\' ids, which none of its questions may take (7.58.01)', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ImproveSheet isOpen onClose={vi.fn<() => void>()} />, current(), { meta: { retired_ids: ['q_old_price'] } })
    await user.type(screen.getByRole('textbox', { name: 'Instruction' }), 'Ask about the price again')
    await user.click(screen.getByRole('button', { name: 'Draft changes' }))
    await screen.findByRole('list', { name: 'Changes from the AI' })
    expect(draftForm.mock.calls[0]?.[0].retired_ids).toStrictEqual(['q_old_price'])
  })

  it('lists each change by id, with the model\'s note', async () => {
    await draftChanges()
    expect(screen.getByRole('checkbox', { name: 'Apply: Changed question 1' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Apply: Added question 2' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Apply: Removed question 3' })).toBeChecked()
    expect(screen.getByText('I added a price follow-up.')).toBeInTheDocument()
  })

  it('applies only the accepted changes into the draft, unsaved, and remembers the form before them', async () => {
    const { user, harness, onClose } = await draftChanges()
    await user.click(screen.getByRole('checkbox', { name: 'Apply: Removed question 3' }))
    await user.click(screen.getByRole('button', { name: 'Apply 2 changes' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_reason', 'q_price', 'q_feature', 'q_comment'])
    expect([harness.probe.current?.ai?.kind, harness.probe.current?.ai?.before]).toStrictEqual(['improve', current()])
    expect(onClose).toHaveBeenCalledWith()
  })

  it('says what goes with a rejected question: the rule that went to it', async () => {
    const { user, harness } = await draftChanges()
    await user.click(screen.getByRole('checkbox', { name: 'Apply: Added question 2' }))
    expect(screen.getByText('Not applied with it: the rule on 1.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply 2 changes' }))
    expect(harness.probe.current?.form.questions.map((q) => [q.id, q.logic])).toStrictEqual([['q_reason', undefined], ['q_feature', undefined]])
  })

  it('holds Apply, saying why, when no change is picked', async () => {
    const { user, harness } = await draftChanges()
    await user.click(screen.getByRole('button', { name: 'Reject all' }))
    expect(screen.getByRole('button', { name: 'Apply 0 changes' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Choose at least one change to apply.')).toBeInTheDocument()
    expect(harness.probe.current?.form).toStrictEqual(current())
  })

  it('says so when the AI changed nothing', async () => {
    draftForm.mockResolvedValue({ form: current(), notes: [], warnings: [] })
    const user = userEvent.setup()
    renderWithDraft(<ImproveSheet isOpen onClose={vi.fn<() => void>()} />, current())
    await user.type(screen.getByRole('textbox', { name: 'Instruction' }), 'Nothing')
    await user.click(screen.getByRole('button', { name: 'Draft changes' }))
    expect(await screen.findByText('The AI made no changes. Try saying more about what should change.')).toBeInTheDocument()
  })

  it('offers "Improve question N" for the selected question', () => {
    renderWithDraft(<ImproveSheet isOpen onClose={vi.fn<() => void>()} />, current(), { rest: ['q_feature'] })
    expect(screen.getByRole('button', { name: 'Improve question 2' })).toBeInTheDocument()
  })
})
