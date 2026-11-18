import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2, LoadedForm } from '../model/formsV2'
import type { FormRemovals } from '../model/removals'

const api = vi.hoisted(() => ({
  getForm: vi.fn<(formId: string) => Promise<LoadedForm>>(),
  createForm: vi.fn<(form: FormV2) => Promise<LoadedForm>>(),
  saveForm: vi.fn<(formId: string, form: FormV2, revision: number, removes?: FormRemovals | null) => Promise<LoadedForm>>(),
  setEnabled: vi.fn<(formId: string, enabled: boolean, revision?: number) => Promise<LoadedForm>>(),
}))

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...real, feedbackFormsV2Api: { ...real.feedbackFormsV2Api, ...api } }
})

import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { useAuthStore } from '../../../store/authStore'
import { STORED_META, renderWithDraft, sampleForm } from '../test/draftHarness'
import SaveButtons from './SaveButtons'
import ConflictBanner from './ConflictBanner'

const conflict = () => new FormsApiError(409, 'The form was changed by someone else', 'revision_conflict', {
  errors: [], retryAfterSeconds: null, current: { revision: 5, updatedBy: 'ana', updatedAt: '2026-11-17T14:02:00Z' },
})
/** The 409 of a save that drops an answered question or option without naming it (the server's lock, D9). */
const answersLocked = () => new FormsApiError(409, 'This form has responses: name each question or option it removes', 'answers_locked', {
  errors: [], retryAfterSeconds: null, current: { revision: null, updatedBy: '', updatedAt: '' },
})
const stored = (form: FormV2, revision: number): LoadedForm => ({ form, meta: { ...STORED_META, revision, can_delete_test_responses: false } })

function renderBuilder(form: FormV2 = sampleForm(), isNew = false, meta: Partial<LoadedForm['meta']> = {}) {
  return renderWithDraft(<><SaveButtons withShortcut /><ConflictBanner /></>, form, { isNew, meta })
}

/** Edit the draft (rename it), so Save shows. */
async function editDraft(harness: ReturnType<typeof renderBuilder>) {
  await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
  harness.probe.current?.update((form) => ({ ...form, name: 'Renamed' }))
}

/** The builder on the sample form, the draft edited, Save pressed: its harness. */
async function editAndSave(): Promise<ReturnType<typeof renderBuilder>> {
  const user = userEvent.setup()
  const harness = renderBuilder()
  await editDraft(harness)
  await user.click(await screen.findByRole('button', { name: 'Save' }))
  return harness
}

describe('saving the draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves a stored form over the revision it was read at (D7)', async () => {
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 4)))
    const harness = await editAndSave()
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null) })
    await waitFor(() => { expect(harness.probe.current?.meta?.revision).toBe(4) })
  })

  it('names nothing it removes while the form has no response: the server holds nothing locked yet', async () => {
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 4)))
    const user = userEvent.setup()
    const harness = renderBuilder(sampleForm({ questions: [...sampleForm().questions, { id: 'q_more', type: 'open_text', headline: { en: 'More?' }, required: false, long: false, input_type: 'text' }] }))
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    act(() => { harness.probe.current?.update((form) => ({ ...form, questions: form.questions.slice(0, 1) })) })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.anything(), 3, null) })
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
    await editDraft(harness)
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
    api.createForm.mockImplementation((form) => Promise.resolve({ form, meta: { ...STORED_META, form_id: 'f_new', revision: 1 } }))
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 2)))
    const user = userEvent.setup()
    renderBuilder(sampleForm(), true)
    await user.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_new', expect.objectContaining({ enabled: true }), 1) })
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

describe('a stale save (409, D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.saveForm.mockRejectedValueOnce(conflict())
  })

  async function saveIntoConflict() {
    const user = userEvent.setup()
    const harness = renderBuilder()
    await editDraft(harness)
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

  it('Save mine saves this draft over the latest revision', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm({ name: 'Theirs' }), 5))
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 6)))
    const { user, banner } = await saveIntoConflict()
    await user.click(within(banner).getByRole('button', { name: 'Save mine' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenLastCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 5, null) })
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument() })
  })

  it('Save mine names what it removes from theirs once theirs is answered', async () => {
    const theirs = sampleForm({ name: 'Theirs', questions: [...sampleForm().questions, { id: 'q_more', type: 'open_text', headline: { en: 'More?' }, required: false, long: false, input_type: 'text' }] })
    api.getForm.mockResolvedValue({ form: theirs, meta: { ...STORED_META, revision: 5, has_responses: true, can_delete_test_responses: false } })
    api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form, 6)))
    const { user, banner } = await saveIntoConflict()
    await user.click(within(banner).getByRole('button', { name: 'Save mine' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenLastCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 5, { questions: ['q_more'] }) })
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
