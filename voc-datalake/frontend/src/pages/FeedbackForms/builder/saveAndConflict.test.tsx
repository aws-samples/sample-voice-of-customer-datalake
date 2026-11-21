import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChoiceQuestion, FormV2, LoadedForm } from '../model/formsV2'
import type { FormRemovals } from '../model/removals'

const api = vi.hoisted(() => ({
  getForm: vi.fn<(formId: string) => Promise<LoadedForm>>(),
  createForm: vi.fn<(form: FormV2) => Promise<LoadedForm>>(),
  saveForm: vi.fn<(formId: string, form: FormV2, revision: number, removes?: FormRemovals | null, writeCount?: number | null) => Promise<LoadedForm>>(),
  setEnabled: vi.fn<(formId: string, enabled: boolean, revision?: number, writeCount?: number) => Promise<LoadedForm>>(),
}))

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) =>
  (await import('../test/formsApiMock')).formsApiWith(importOriginal, api))

import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { useAuthStore } from '../../../store/authStore'
import { STORED_META, renameDraft, renderWithDraft, sampleForm } from '../test/draftHarness'
import SaveButtons from './SaveButtons'
import ConflictBanner from './ConflictBanner'

const conflict = () => new FormsApiError(409, 'The form was changed by someone else', 'revision_conflict', {
  errors: [], retryAfterSeconds: null, current: { revision: 5, updatedBy: 'ana', updatedAt: '2026-11-17T14:02:00Z' },
})
/** The 409 of a save that drops an answered question or option without naming it (the server's lock, D9). */
const answersLocked = () => new FormsApiError(409, 'This form has responses: name each question or option it removes', 'answers_locked', {
  errors: [], retryAfterSeconds: null, current: { revision: null, updatedBy: '', updatedAt: '' },
})
/** The 400 of a save that gives a question a removed question's id (lambda/shared/forms_v2.py `validate_definition`). */
const idReused = () => new FormsApiError(400, 'questions: the id "q_old" belonged to a removed question; ids are never reused', 'question_id_reused', {
  errors: [], retryAfterSeconds: null, current: null, questionId: 'q_old',
})
const stored = (form: FormV2, revision: number): LoadedForm => ({ form, meta: { ...STORED_META, revision, can_delete_test_responses: false } })

function renderBuilder(form: FormV2 = sampleForm(), isNew = false, meta: Partial<LoadedForm['meta']> = {}) {
  return renderWithDraft(<><SaveButtons withShortcut /><ConflictBanner /></>, form, { isNew, meta })
}

/** The builder on the sample form, the draft edited, Save pressed: its harness. */
async function editAndSave(): Promise<ReturnType<typeof renderBuilder>> {
  const user = userEvent.setup()
  const harness = renderBuilder()
  await renameDraft(harness)
  await user.click(await screen.findByRole('button', { name: 'Save' }))
  return harness
}

describe('saving the draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves a stored form over the revision and the save count it was read at (D7)', async () => {
    api.saveForm.mockImplementation((_id, form) => Promise.resolve({ ...stored(form, 4), meta: { ...stored(form, 4).meta, write_count: 6 } }))
    const harness = await editAndSave()
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null, 5) })
    await waitFor(() => { expect(harness.probe.current?.meta?.revision).toBe(4) })
    // The next save is over the count this one answered.
    expect(harness.probe.current?.meta?.write_count).toBe(6)
  })

  it('words a removed question\'s id taken again with the id, and keeps the draft', async () => {
    api.saveForm.mockRejectedValueOnce(idReused())
    const harness = await editAndSave()
    await waitFor(() => { expect(harness.probe.current?.status).toStrictEqual({ kind: 'failed', reason: 'question_id_reused', questionId: 'q_old' }) })
    expect([harness.probe.current?.conflict, harness.probe.current?.form.name]).toStrictEqual([null, 'Renamed'])
  })

  it('blocks a save that changes an answered question\'s type, as the server would refuse it', async () => {
    const harness = renderBuilder(sampleForm(), false, { has_responses: true })
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    act(() => {
      harness.probe.current?.update((form) => ({ ...form, questions: form.questions.map((q) => ({ id: q.id, type: 'nps' as const, headline: q.headline, required: q.required })) }))
    })
    expect(harness.probe.current?.errors.map((problem) => [problem.code, problem.at.id])).toContainEqual(['answeredReshaped', 'q_feedback'])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(api.saveForm).not.toHaveBeenCalled()
  })

  it('names nothing it removes while the form has no response: the server holds nothing locked yet', async () => {
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 4)))
    const user = userEvent.setup()
    const harness = renderBuilder(sampleForm({ questions: [...sampleForm().questions, { id: 'q_more', type: 'open_text', headline: { en: 'More?' }, required: false, long: false, input_type: 'text' }] }))
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    act(() => { harness.probe.current?.update((form) => ({ ...form, questions: form.questions.slice(0, 1) })) })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.anything(), 3, null, 5) })
  })

  it('a save the lock refuses (answers_locked) is no stale save: it fails with the reason and locks the draft', async () => {
    api.saveForm.mockRejectedValueOnce(answersLocked())
    const harness = await editAndSave()
    await waitFor(() => { expect(harness.probe.current?.status).toStrictEqual({ kind: 'failed', reason: 'This form has responses: name each question or option it removes' }) })
    expect([harness.probe.current?.conflict, harness.probe.current?.locked]).toStrictEqual([null, true])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the response count it read, and the lock, across a save that answers neither', async () => {
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 4)))
    const user = userEvent.setup()
    const harness = renderBuilder(sampleForm(), false, { response_count: 12, has_responses: true, can_delete_test_responses: true })
    await renameDraft(harness)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(harness.probe.current?.meta?.revision).toBe(4) })
    expect(harness.probe.current?.meta).toMatchObject({ response_count: 12, has_responses: true, can_delete_test_responses: true })
    expect(harness.probe.current?.locked).toBe(true)
  })

  it('creates a new form Off on its first save, and gives the page its id', async () => {
    api.createForm.mockImplementation((form) => Promise.resolve({ form, meta: { ...STORED_META, form_id: 'f_new', revision: 1 } }))
    const user = userEvent.setup()
    const harness = renderBuilder(sampleForm(), true)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(harness.onCreated).toHaveBeenCalledWith('f_new') })
    expect(api.createForm).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it('publishes a new form: created Off, then saved Live over its first revision', async () => {
    api.createForm.mockImplementation((form) => Promise.resolve({ form, meta: { ...STORED_META, form_id: 'f_new', revision: 1, write_count: 0 } }))
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 2)))
    const user = userEvent.setup()
    renderBuilder(sampleForm(), true)
    await user.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_new', expect.objectContaining({ enabled: true }), 1, null, 0) })
  })

  it('holds Save while a problem blocks it, and says why', async () => {
    const user = userEvent.setup()
    renderBuilder(sampleForm({ questions: [{ id: 'q_feedback', type: 'open_text', headline: {}, required: true, long: true, input_type: 'text' }] }), true)
    const save = await screen.findByRole('button', { name: 'Save' })
    await user.click(save)
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(api.createForm).not.toHaveBeenCalledWith(expect.anything())
  })
})

describe('the shortcut and what a save asks first', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 4)))
  })

  const reason: ChoiceQuestion = {
    id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true, other: { enabled: false }, none: { enabled: false },
    shuffle: 'none', display: 'list', options: [{ code: 'price', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }],
  }
  /** A live form people answered: a choice, the open question, and two endings. */
  const live = sampleForm({
    enabled: true, questions: [reason, ...sampleForm().questions],
    endings: [...sampleForm().endings, { id: 'end_bye', title: { en: 'Bye' } }],
  })

  /** Take out the open question, the option Bugs and the ending Bye, then press Update live form. */
  async function updateWithRemovals() {
    const user = userEvent.setup()
    const harness = renderBuilder(live, false, { has_responses: true, response_count: 12 })
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    act(() => {
      harness.probe.current?.update((form) => ({
        ...form, questions: [{ ...reason, options: reason.options.slice(0, 1) }], endings: form.endings.slice(0, 1),
      }))
    })
    await user.click(screen.getByRole('button', { name: 'Update live form' }))
    return { user, dialog: screen.getByRole('dialog', { name: 'Update the live form?' }) }
  }

  it('saves with Ctrl+S', async () => {
    const user = userEvent.setup()
    const harness = renderBuilder()
    await renameDraft(harness)
    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null, 5) })
  })

  it('lists what an update of a live form removes that people answered, and updates once confirmed', async () => {
    const { user, dialog } = await updateWithRemovals()
    expect(dialog).toHaveTextContent('Removed: question “What would you like to tell us?”, option “Bugs”, ending “Bye”. Their answers stay in Results.')
    expect(api.saveForm).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything())
    await user.click(within(dialog).getByRole('button', { name: 'Update live form' }))
    // The server is told what the person removed (D9): the question and the option, by id and code.
    await waitFor(() => {
      expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ enabled: true, endings: live.endings.slice(0, 1) }), 3,
        { questions: ['q_feedback'], options: { q_reason: ['bugs'] } }, 5)
    })
  })

  it('updates a live form at once when the edit removes nothing', async () => {
    const user = userEvent.setup()
    const harness = renderBuilder(live, false, { has_responses: true, response_count: 12 })
    await renameDraft(harness)
    await user.click(await screen.findByRole('button', { name: 'Update live form' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null, 5) })
    expect(screen.queryByRole('dialog', { name: 'Update the live form?' })).not.toBeInTheDocument()
  })

  it('keeps the live form as it is when the update is cancelled', async () => {
    const { user, dialog } = await updateWithRemovals()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Update the live form?' })).not.toBeInTheDocument()
    expect(api.saveForm).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('asks before publishing an AI draft nobody has saved, then publishes it', async () => {
    api.createForm.mockImplementation((form) => Promise.resolve({ form, meta: { ...STORED_META, form_id: 'f_new', revision: 1, write_count: 0 } }))
    const user = userEvent.setup()
    renderWithDraft(<SaveButtons />, sampleForm(), {
      isNew: true, handoff: { ai: { notes: [], warnings: [], description: 'Ask why people cancel', channel: 'link', addresses: [] } },
    })
    await user.click(screen.getByRole('button', { name: 'Publish' }))
    const dialog = screen.getByRole('dialog', { name: 'Publish this AI draft?' })
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_new', expect.objectContaining({ enabled: true }), 1, null, 0) })
  })
})

describe('a stale save (409, D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.saveForm.mockRejectedValueOnce(conflict())
  })

  async function saveIntoConflict() {
    const user = userEvent.setup()
    const harness = renderBuilder()
    await renameDraft(harness)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    const banner = await screen.findByRole('alert')
    return { user, harness, banner }
  }

  it('says someone else saved first (the server names them by sub, never a name), with Compare, Reload theirs and Save mine', async () => {
    useAuthStore.setState({ user: { username: 'bo', email: 'bo@example.com', groups: ['users'], sub: 'bo' } })
    const { banner } = await saveIntoConflict()
    expect(banner).toHaveTextContent('Someone else saved this form while you were editing it.')
    expect(banner).not.toHaveTextContent('ana')
    expect(within(banner).getAllByRole('button').map((button) => button.textContent)).toStrictEqual(['Compare', 'Reload theirs', 'Save mine'])
  })

  it('says it was the person themselves, in another tab, when the saver is them', async () => {
    useAuthStore.setState({ user: { username: 'ana', email: 'ana@example.com', groups: ['users'], sub: 'ana' } })
    const { banner } = await saveIntoConflict()
    expect(banner).toHaveTextContent(/You saved this form at .+, in another tab or window\./)
  })

  /** Run into the conflict with `theirs` stored, then press Save mine. */
  async function saveMineOver(theirs: LoadedForm) {
    api.getForm.mockResolvedValue(theirs)
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 6)))
    const { user, banner } = await saveIntoConflict()
    await user.click(within(banner).getByRole('button', { name: 'Save mine' }))
  }

  it('Save mine saves this draft over the latest revision', async () => {
    await saveMineOver({ ...stored(sampleForm({ name: 'Theirs' }), 5), meta: { ...STORED_META, revision: 5, write_count: 9 } })
    // Over theirs: its revision and its save count, read again.
    await waitFor(() => { expect(api.saveForm).toHaveBeenLastCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 5, null, 9) })
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument() })
  })

  it("Save mine names what it removes from theirs once theirs is answered", async () => {
    const theirs = sampleForm({ name: 'Theirs', questions: [...sampleForm().questions, { id: 'q_more', type: 'open_text', headline: { en: 'More?' }, required: false, long: false, input_type: 'text' }] })
    await saveMineOver({ form: theirs, meta: { ...STORED_META, revision: 5, has_responses: true, can_delete_test_responses: false } })
    await waitFor(() => { expect(api.saveForm).toHaveBeenLastCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 5, { questions: ['q_more'] }, 5) })
  })

  it('Reload theirs drops this draft for the latest version', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm({ name: 'Theirs' }), 5))
    const { user, harness, banner } = await saveIntoConflict()
    await user.click(within(banner).getByRole('button', { name: 'Reload theirs' }))
    await waitFor(() => { expect(harness.probe.current?.form.name).toBe('Theirs') })
    expect(harness.probe.current?.meta?.revision).toBe(5)
  })

  it('Compare lists what saving mine would change in theirs', async () => {
    const theirs = sampleForm({ endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }, { id: 'end_bye', title: { en: 'Bye' } }] })
    api.getForm.mockResolvedValue(stored(theirs, 5))
    const { user, banner } = await saveIntoConflict()
    await user.click(within(banner).getByRole('button', { name: 'Compare' }))
    const sheet = await screen.findByRole('dialog', { name: 'Their version and yours' })
    expect(within(sheet).getByText('Ending: Bye')).toBeInTheDocument()
    expect(within(sheet).getByText('Yours removes')).toBeInTheDocument()
  })
})
