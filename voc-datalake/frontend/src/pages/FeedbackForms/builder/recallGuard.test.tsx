/**
 * Idea 10's publish guard and the matrix lock in the builder: a placeholder respondents would see as written
 * (an option's label) blocks Publish and Update live form, never Save; the server's 409 `unresolved_placeholder` and
 * its 400 `recall_*` are refusals worded in the header, never the stale-save banner; an answered matrix's removed rows
 * and columns are named in `removes`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2, LoadedForm, MatrixQuestion, Question } from '../model/formsV2'

type FormsApi = typeof import('../../../api/feedbackFormsV2Api').feedbackFormsV2Api
const formsApi = vi.hoisted(() => ({ saveForm: vi.fn<FormsApi['saveForm']>() }))
vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => (await import('../test/formsApiMock')).formsApiWith(importOriginal, formsApi))

import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { STORED_META, renameDraft, renderWithDraft, sampleForm } from '../test/draftHarness'
import type { DraftHarnessOptions } from '../test/draftHarness'
import BuilderHeader from './BuilderHeader'
import ConflictBanner from './ConflictBanner'

const en = (text: string) => ({ en: text })
const pick: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Which one?'), required: true, options: [{ code: 'a', label: en('Option {{event}}') }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}
const matrix: MatrixQuestion = {
  id: 'q_phases', type: 'matrix', headline: en('How was each phase?'), required: true, shuffle_rows: false, display: 'auto',
  rows: [{ code: 'intro', label: en('Intro') }, { code: 'lab', label: en('Lab') }],
  columns: [{ code: 'poor', label: en('Poor') }, { code: 'good', label: en('Good') }, { code: 'great', label: en('Great') }],
}
const saved = (form: FormV2): LoadedForm => ({ form, meta: { ...STORED_META, revision: 4 } })
const refusal = (status: number, code: string) => new FormsApiError(status, 'Refused', code, { errors: [], retryAfterSeconds: null, current: null })

function renderHeader(form: FormV2, options: DraftHarnessOptions = {}) {
  return { user: userEvent.setup(), ...renderWithDraft(<><BuilderHeader /><ConflictBanner /></>, form, options) }
}

/** The header's own button (the narrow screens' bar repeats Save and Publish). */
async function headerButton(name: string): Promise<HTMLElement> {
  const [button] = await screen.findAllByRole('button', { name })
  if (button === undefined) throw new Error(`No ${name} button`)
  return button
}

beforeEach(() => {
  vi.clearAllMocks()
  formsApi.saveForm.mockImplementation((_id, form) => Promise.resolve(saved(form)))
})

describe('the publish guard in the builder', () => {
  it('blocks Publish for a placeholder in an option label, and still saves the draft', async () => {
    const harness = renderHeader(sampleForm({ questions: [pick], hidden_fields: [{ id: 'event' }] }))
    await renameDraft(harness)
    expect(await headerButton('Publish')).toHaveAttribute('aria-disabled', 'true')
    expect(harness.probe.current?.publishErrors.map((problem) => problem.code)).toStrictEqual(['recallNotHere'])
    await harness.user.click(await headerButton('Save'))
    await waitFor(() => { expect(formsApi.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null, 5) })
  })

  it('words the server\'s 409 unresolved_placeholder as a refusal, never as someone else\'s save', async () => {
    formsApi.saveForm.mockRejectedValueOnce(refusal(409, 'unresolved_placeholder'))
    const harness = renderHeader(sampleForm({ enabled: true }))
    await renameDraft(harness)
    await harness.user.click(await headerButton('Update live form'))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: a live form can't show a {…} placeholder as written.")
    expect(screen.queryByText('Someone else saved this form while you were editing it.')).toBeNull()
  })

  it.each(['recall_unknown', 'recall_not_before', 'recall_type'])('words the server\'s 400 %s as one recall refusal', async (code) => {
    formsApi.saveForm.mockRejectedValueOnce(refusal(400, code))
    const harness = renderHeader(sampleForm())
    await renameDraft(harness)
    await harness.user.click(await headerButton('Save'))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: a text recalls a value it can't show where it stands.")
  })
})

describe('an answered matrix', () => {
  it('names the rows and columns a save removes', async () => {
    const harness = renderHeader(sampleForm({ questions: [matrix] }), { meta: { has_responses: true } })
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    act(() => {
      harness.probe.current?.update((form) => ({ ...form, questions: [{ ...matrix, rows: matrix.rows.slice(1), columns: matrix.columns.slice(0, 2) }] }))
    })
    await harness.user.click(await headerButton('Save'))
    await waitFor(() => {
      expect(formsApi.saveForm).toHaveBeenCalledWith('f_test', expect.anything(), 3, { rows: { q_phases: ['intro'] }, columns: { q_phases: ['great'] } }, 5)
    })
  })
})
