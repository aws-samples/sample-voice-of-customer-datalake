import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import type { FormV2, LoadedForm } from '../model/formsV2'

/** The forms API the header saves through (a type only: `vi.hoisted` runs before the imports). */
type FormsApi = typeof import('../../../api/feedbackFormsV2Api').feedbackFormsV2Api

const formsApi = vi.hoisted(() => ({
  saveForm: vi.fn<FormsApi['saveForm']>(),
  createForm: vi.fn<FormsApi['createForm']>(),
  setEnabled: vi.fn<FormsApi['setEnabled']>(),
}))
vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => (await import('../test/formsApiMock')).formsApiWith(importOriginal, formsApi))

import { api } from '../../../api/client'
import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { STORED_META, renderWithDraft, sampleForm } from '../test/draftHarness'
import type { DraftHarnessOptions } from '../test/draftHarness'
import { FakeBroadcastChannel } from '../test/fakeBroadcastChannel'
import PreviewWindowProvider from '../preview/PreviewWindowProvider'
import { readHandoff } from './newFormHandoff'
import BuilderHeader from './BuilderHeader'

/** Where the builder sent the person, and the new form it handed over (Duplicate). */
function WhereAmI() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}<span data-testid="handed">{JSON.stringify(readHandoff(location.state)?.form ?? null)}</span></p>
}

function renderHeader(form: FormV2 = sampleForm(), options: DraftHarnessOptions = {}) {
  const user = userEvent.setup()
  return { user, ...renderWithDraft(<><BuilderHeader /><WhereAmI /></>, form, options) }
}

type Rendered = ReturnType<typeof renderHeader>

/** The header's own button `name` (the narrow screens' action bar repeats Save and Publish). */
function headerButton(name: string): HTMLElement {
  const [button] = screen.getAllByRole('button', { name })
  if (button === undefined) throw new Error(`No ${name} button`)
  return button
}

async function rename(harness: Rendered, name: string) {
  await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
  act(() => { harness.probe.current?.update((form) => ({ ...form, name })) })
}

async function pick(user: Rendered['user'], item: RegExp) {
  await user.click(screen.getByRole('button', { name: 'More form actions' }))
  await user.click(screen.getByRole('menuitem', { name: item }))
}

const saved = (form: FormV2, overrides: Partial<LoadedForm['meta']> = {}): LoadedForm => ({ form, meta: { ...STORED_META, revision: 4, ...overrides } })
const unwritten = sampleForm({ questions: [{ id: 'q_feedback', type: 'open_text', headline: {}, required: true, long: true, input_type: 'text' }] })
const AI_DRAFT: DraftHarnessOptions = {
  isNew: true, handoff: { ai: { notes: [], warnings: [], description: 'Ask why people cancel', channel: 'link', addresses: [] } },
}

beforeEach(() => {
  vi.clearAllMocks()
  formsApi.saveForm.mockImplementation((_id, form) => Promise.resolve(saved(form)))
  formsApi.createForm.mockImplementation((form) => Promise.resolve(saved(form, { form_id: 'f_new', revision: 1 })))
  formsApi.setEnabled.mockImplementation(() => Promise.resolve(saved(sampleForm())))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the form name', () => {
  it('reads "Untitled form" while the form has no name', () => {
    renderHeader(sampleForm({ name: '  ' }))
    expect(screen.getByRole('heading', { name: 'Untitled form' })).toBeInTheDocument()
  })

  it('is renamed inline: Enter keeps the new name, trimmed', async () => {
    const { user, probe } = renderHeader()
    await user.click(screen.getByRole('button', { name: 'Rename the form' }))
    const field = screen.getByRole('textbox', { name: 'Form name (internal)' })
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, '  Pilot form {Enter}')
    expect(screen.getByRole('heading', { name: 'Pilot form' })).toBeInTheDocument()
    expect(probe.current?.form.name).toBe('Pilot form')
  })

  it('keeps the name it had on Escape', async () => {
    const { user, probe } = renderHeader()
    await user.click(screen.getByRole('button', { name: 'Rename the form' }))
    await user.type(screen.getByRole('textbox', { name: 'Form name (internal)' }), ' draft{Escape}')
    expect(screen.getByRole('heading', { name: 'Sample form' })).toBeInTheDocument()
    expect(probe.current?.form.name).toBe('Sample form')
  })

  it('keeps what was typed when the field is left', async () => {
    const { user, probe } = renderHeader()
    await user.click(screen.getByRole('button', { name: 'Rename the form' }))
    await user.type(screen.getByRole('textbox', { name: 'Form name (internal)' }), ' v2')
    await user.tab()
    expect(probe.current?.form.name).toBe('Sample form v2')
  })
})

describe('the state and the save status', () => {
  it.each([
    ['a stored form that is off', sampleForm(), {}, 'Off'],
    ['a live form', sampleForm({ enabled: true }), {}, 'Live'],
    ['a new form', sampleForm(), { isNew: true }, 'Not saved yet'],
    ['a form whose test link is on', sampleForm({ settings: { test: { link_enabled: true, record: 'tag' } } }), {}, 'Test link on'],
  ])('marks %s', (_state, form, options, chip) => {
    renderHeader(form, options)
    expect(screen.getByText(chip)).toBeInTheDocument()
  })

  it('says nothing until an edit, then that it is unsaved', async () => {
    const harness = renderHeader()
    expect(screen.getByRole('status')).toHaveTextContent(/^$/)
    await rename(harness, 'Renamed')
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
  })

  it('says how many problems hold the save', () => {
    renderHeader(unwritten)
    expect(screen.getByRole('status')).toHaveTextContent('Fix 1 problem to save.')
  })

  it.each([
    ['a save', 'Save', {}, 'Saved'],
    ['a new form\'s first save', 'Save', { isNew: true }, 'Saved. This form is Off: its link shows “Feedback form unavailable.” until you publish it.'],
    ['a publish', 'Publish', {}, 'Live. Respondents see this version from now on.'],
    ['the first save of an AI draft', 'Save', AI_DRAFT, 'Saved. The AI draft is now your form.'],
  ])('says what %s did', async (_save, button, options, message) => {
    const harness = renderHeader(sampleForm(), options)
    await rename(harness, 'Renamed')
    await harness.user.click(headerButton(button))
    // (the status line holds the message, and beside it a warning when there is one)
    expect((await screen.findByText(message)).closest('[role="status"]')).not.toBeNull()
  })

  it('says why a save failed, and Try again saves again', async () => {
    formsApi.saveForm.mockRejectedValueOnce(new FormsApiError(500, 'The database is down', undefined, { errors: [], retryAfterSeconds: null, current: null }))
    const harness = renderHeader()
    await rename(harness, 'Renamed')
    await harness.user.click(headerButton('Save'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn\'t save: The database is down.')
    await harness.user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(formsApi.saveForm).toHaveBeenCalledTimes(2)
  })

  it('words a failure without a reason as a generic one', async () => {
    formsApi.saveForm.mockRejectedValueOnce(new Error(''))
    const harness = renderHeader()
    await rename(harness, 'Renamed')
    await harness.user.click(headerButton('Save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t save. Check your connection and try again.')
  })

  it('words a removed question\'s id taken again with the id, never the server\'s raw message', async () => {
    formsApi.saveForm.mockRejectedValueOnce(new FormsApiError(400, 'questions: the id "q_old" belonged to a removed question; ids are never reused',
      'question_id_reused', { errors: [], retryAfterSeconds: null, current: null, questionId: 'q_old' }))
    const harness = renderHeader()
    await rename(harness, 'Renamed')
    await harness.user.click(headerButton('Save'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't save: the id q_old belonged to a question removed earlier, and ids are never reused. Give that question another id under Advanced.")
  })

  it('lists the server\'s own refusals of the save under Other problems', async () => {
    formsApi.saveForm.mockRejectedValueOnce(new FormsApiError(400, 'Invalid form', undefined, {
      errors: [{ message: 'Question 4 has 52 options' }], retryAfterSeconds: null, current: null,
    }))
    const harness = renderHeader()
    await rename(harness, 'Renamed')
    await harness.user.click(headerButton('Save'))
    await harness.user.click(await screen.findByRole('button', { name: '1 problem' }))
    const problems = screen.getByRole('region', { name: 'Problems in this form' })
    expect(within(problems).getByText('Other problems')).toBeInTheDocument()
    expect(within(problems).getByText('Question 4 has 52 options')).toBeInTheDocument()
  })
})

describe('the ⋯ menu', () => {
  it('opens Improve with AI', async () => {
    const { user, openImprove } = renderHeader()
    await pick(user, /^Improve with AI/)
    expect(openImprove).toHaveBeenCalledWith()
  })

  it('holds Discard changes while there is nothing to discard, saying why', async () => {
    const { user } = renderHeader()
    await user.click(screen.getByRole('button', { name: 'More form actions' }))
    expect(screen.getByRole('menuitem', { name: /^Discard changes/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('There are no unsaved changes.')).toBeInTheDocument()
  })

  it('asks before discarding, then the form goes back to its last save', async () => {
    const harness = renderHeader()
    await rename(harness, 'Renamed')
    await pick(harness.user, /^Discard changes/)
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' })
    expect(dialog).toHaveTextContent('The form goes back to how it was last saved.')
    await harness.user.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
    expect(harness.probe.current?.form.name).toBe('Sample form')
  })

  it('keeps the edits when the discard is cancelled', async () => {
    const harness = renderHeader(sampleForm(), { isNew: true })
    await pick(harness.user, /^Discard changes/)
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' })
    expect(dialog).toHaveTextContent('The form goes back to how it opened. Nothing was saved.')
    await harness.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).not.toBeInTheDocument()
  })

  it('duplicates the form as a new, unsaved copy that is Off and has no test link', async () => {
    const { user } = renderHeader(sampleForm({ enabled: true, settings: { test: { link_enabled: true, record: 'drop' } } }))
    await pick(user, /^Duplicate form/)
    const copy = sampleForm({ name: 'Sample form (copy)', settings: { test: { link_enabled: false, record: 'drop' } } })
    const handed: unknown = JSON.parse(screen.getByTestId('handed').textContent)
    expect(screen.getByTestId('where').firstChild).toHaveTextContent('/feedback-forms/new/questions')
    expect(handed).toStrictEqual(copy)
  })

  it.each<[string, boolean, unknown[]]>([
    ['at a desktop size', true, [expect.stringMatching(/^\/form-preview\.html#s=[\w-]+&ui=en&p=desktop&/u), 'voc-form-preview', 'popup=yes,width=1280,height=840']],
    ['on a phone, in a new tab', false, [expect.stringMatching(/^\/form-preview\.html#s=[\w-]+&ui=en&p=phone&.*&tab=1$/u), 'voc-form-preview']],
  ])('opens the draft in the preview window, saved or not: %s', async (_where, wide, call) => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    onTestFinished(() => { FakeBroadcastChannel.reset(); window.sessionStorage.clear(); vi.unstubAllGlobals() })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    renderWithDraft(<PreviewWindowProvider form={sampleForm()} formKey="new"><BuilderHeader /></PreviewWindowProvider>, sampleForm(), { isNew: true })
    await pick(user, /^Preview in a window/)
    expect(open).toHaveBeenCalledExactlyOnceWith(...call)
  })

  it('holds the delete of a new form until it is saved', async () => {
    const { user } = renderHeader(sampleForm(), { isNew: true })
    await user.click(screen.getByRole('button', { name: 'More form actions' }))
    expect(screen.getByRole('menuitem', { name: /^Preview in a window/ })).not.toHaveAttribute('aria-disabled')
    expect(screen.getByRole('menuitem', { name: /^Delete form/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByText('Save the form first.')).toHaveLength(1)
  })

  it('turns a live form off, and says what that means', async () => {
    const { user } = renderHeader(sampleForm({ enabled: true }))
    await pick(user, /^Turn off/)
    expect(await screen.findByText('Turned off. Its link shows “Feedback form unavailable.”; the test link keeps working.')).toBeInTheDocument()
    expect(formsApi.setEnabled).toHaveBeenCalledWith('f_test', false, 3, 5)
  })

  it('offers no Turn off for a form that is off', async () => {
    const { user } = renderHeader()
    await user.click(screen.getByRole('button', { name: 'More form actions' }))
    expect(screen.queryByRole('menuitem', { name: /^Turn off/ })).not.toBeInTheDocument()
  })

  it('deletes the form after naming it and its responses, then leaves for the list', async () => {
    const remove = vi.spyOn(api, 'deleteFeedbackForm').mockResolvedValue({ success: true })
    const { user, leave } = renderHeader(sampleForm(), { meta: { response_count: 12, has_responses: true } })
    await pick(user, /^Delete form/)
    const dialog = screen.getByRole('dialog', { name: 'Delete the form?' })
    expect(dialog).toHaveTextContent('Delete “Sample form” and its 12 responses? Its link stops working. This can\'t be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Delete form' }))
    await waitFor(() => { expect(leave).toHaveBeenCalledWith('/feedback-forms') })
    expect(remove).toHaveBeenCalledWith('f_test')
  })

  it('asks plainly before deleting a form nobody answered, and Cancel keeps it', async () => {
    const remove = vi.spyOn(api, 'deleteFeedbackForm').mockResolvedValue({ success: true })
    const { user } = renderHeader()
    await pick(user, /^Delete form/)
    const dialog = screen.getByRole('dialog', { name: 'Delete the form?' })
    expect(dialog).toHaveTextContent('Delete “Sample form”? Its link stops working. This can\'t be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalledWith(expect.anything())
  })
})
