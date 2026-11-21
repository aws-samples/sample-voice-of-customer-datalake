/**
 * The Test tab (UX §9.1): the test link with its token, Keep / Check only, the reset and the delete (each asked
 * first, a failure said in its dialog), Make the test link (never while the token is read, never a rotation, the saved
 * settings sent back as they are), and the recent test responses with their hidden values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

type Keep = { link_enabled: boolean; record: 'tag' | 'drop' }
const rotateTestToken = vi.fn<(formId: string, keep: Keep) => Promise<string>>()
const issueTestLink = vi.fn<(formId: string, body: Keep) => Promise<{ token: string; link_enabled: boolean; record: 'tag' | 'drop' }>>()
const deleteTestResponses = vi.fn<(formId: string) => Promise<number>>()
const getResponses = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const createForm = vi.fn<(form: FormV2) => Promise<LoadedForm>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return {
    ...actual,
    feedbackFormsV2Api: {
      ...actual.feedbackFormsV2Api,
      rotateTestToken: (formId: string, keep: Keep) => rotateTestToken(formId, keep),
      issueTestLink: (formId: string, body: Keep) => issueTestLink(formId, body),
      deleteTestResponses: (formId: string) => deleteTestResponses(formId),
      getResponses: (...args: unknown[]) => getResponses(...args),
      createForm: (form: FormV2) => createForm(form),
    },
  }
})

import { useConfigStore } from '../../../store/configStore'
import { STORED_META, renderWithDraft, sampleForm } from '../test/draftHarness'
import type { FormV2, LoadedForm } from '../model/formsV2'
import TestTab from './TestTab'

const LINK = 'https://api.example.com/feedback-forms/f_test/iframe?test=tk_test'

function formWith(test: FormV2['settings']['test'], hidden: FormV2['hidden_fields'] = []): FormV2 {
  return sampleForm({ settings: { test }, hidden_fields: hidden })
}

const TEST_RESPONSE = {
  response_id: 'r_1', submitted_at: '2026-11-17T14:02:00Z', form_revision: 3, language: 'pl',
  answers: { q_feedback: 'Działa' }, hidden: { user_id: 'qa-17', app_version: '' }, ending_id: 'end_thanks', is_test: true,
}

describe('TestTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: 'https://api.example.com' } })
    getResponses.mockResolvedValue({ responses: [], next_cursor: null })
    rotateTestToken.mockResolvedValue('tk_new')
    issueTestLink.mockResolvedValue({ token: 'tk_made', link_enabled: false, record: 'tag' })
    deleteTestResponses.mockResolvedValue(2)
    createForm.mockImplementation((form) => Promise.resolve({ form, meta: STORED_META }))
  })

  it('shows the test link with the form test token while the link is on', () => {
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    expect(screen.getByRole('textbox', { name: 'Test link' })).toHaveValue(LINK)
    expect(screen.getByRole('button', { name: 'QR' })).toBeInTheDocument()
  })

  it('opens the test link from beside Copy and QR, in a new tab', () => {
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    const open = screen.getByRole('link', { name: /^Open\s?\(opens in a new tab\)$/u })
    expect(open).toHaveAttribute('href', LINK)
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('dates each recent test response, "Today" for today\'s, so the order reads across midnight', async () => {
    const today = new Date()
    today.setHours(10, 20, 0, 0)
    getResponses.mockResolvedValue({ responses: [{ ...TEST_RESPONSE, response_id: 'r_today', submitted_at: today.toISOString() }, TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }, [{ id: 'user_id' }, { id: 'app_version' }]))
    const list = await screen.findByRole('list', { name: 'Recent test responses' })
    const times = within(list).getAllByRole('listitem').map((item) => item.querySelector('.font-mono')?.textContent)
    expect(times[0]).toMatch(/^Today 10:20\s?AM$/u)
    expect(times[1]).toMatch(new RegExp(`^Nov 17(, 2026)?, \\d{1,2}:02\\s?[AP]M$`, 'u'))
  })

  it('says what an off link means, and turns it on in the draft', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<TestTab />, formWith({ link_enabled: false, record: 'tag' }))
    expect(screen.getByText('The test link is off. Turn it on to try the form from your app without counting the responses.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Test link' }))
    expect(harness.probe.current?.form.settings.test.link_enabled).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Test link' })).toHaveValue(LINK)
  })

  it('writes Check only into the form settings, and says nothing is kept', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(screen.getByRole('radio', { name: /Check them, keep nothing/ }))
    expect(harness.probe.current?.form.settings.test.record).toBe('drop')
    expect(screen.getByText(/Check only keeps nothing/)).toBeInTheDocument()
  })

  it('resets the test link only after asking, then shows the new one', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(screen.getByRole('button', { name: 'More actions for the test link' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reset test link…' }))
    expect(rotateTestToken).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset test link' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test link' })).toHaveValue('https://api.example.com/feedback-forms/f_test/iframe?test=tk_new'))
    // (the saved settings go back as they are: a reset never turns the saved link on, nor changes how it records)
    expect(rotateTestToken).toHaveBeenCalledWith('f_test', { link_enabled: true, record: 'tag' })
  })

  it('lists recent test responses with their hidden values, an empty one marked', async () => {
    getResponses.mockResolvedValue({ responses: [TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }, [{ id: 'user_id' }, { id: 'app_version' }]))
    const list = await screen.findByRole('list', { name: 'Recent test responses' })
    expect(within(list).getByText(/user_id: qa-17 · app_version: —/)).toBeInTheDocument()
    expect(within(list).getByText('empty')).toBeInTheDocument()
    expect(getResponses).toHaveBeenCalledWith('f_test', { days: null, language: '', ending: '', hidden: {}, includeTest: true }, { limit: 20, testOnly: true })
  })

  it('opens a test response in the response sheet', async () => {
    const user = userEvent.setup()
    getResponses.mockResolvedValue({ responses: [TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(await screen.findByRole('button', { name: /Open the test response from/ }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText('Działa')).toBeInTheDocument()
    expect(within(sheet).getByText('Answered on version 3')).toBeInTheDocument()
  })

  it('deletes every test response only after asking, then reads them again', async () => {
    const user = userEvent.setup()
    getResponses.mockResolvedValue({ responses: [TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(await screen.findByRole('button', { name: 'Delete all…' }))
    expect(deleteTestResponses).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete test responses' }))
    await waitFor(() => expect(deleteTestResponses).toHaveBeenCalledWith('f_test'))
    await waitFor(() => expect(getResponses).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says a failed delete in its dialog, which stays open for another try', async () => {
    const user = userEvent.setup()
    deleteTestResponses.mockRejectedValueOnce(new Error('Network down'))
    getResponses.mockResolvedValue({ responses: [TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(await screen.findByRole('button', { name: 'Delete all…' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete test responses' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't delete the test responses. Try again in a moment.")
    await user.click(within(dialog).getByRole('button', { name: 'Delete test responses' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deleteTestResponses).toHaveBeenCalledTimes(2)
  })

  it('offers Delete all only to an administrator or the form\'s creator, and says to the others who can', async () => {
    getResponses.mockResolvedValue({ responses: [TEST_RESPONSE], next_cursor: null })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }), { meta: { can_delete_test_responses: false } })
    expect(await screen.findByText("Test responses are kept until an administrator or the form's creator deletes them.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete all…' })).not.toBeInTheDocument()
  })

  it('says how to send the first test response when there is none yet', async () => {
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    expect(await screen.findByText('No test responses yet. Open the test link, or scan its QR code on a phone, and send one.')).toBeInTheDocument()
  })

  it('asks a new form to be saved before it has a test link', () => {
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }), { isNew: true })
    expect(screen.getByText('Save the form to get its links.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(getResponses).not.toHaveBeenCalled()
  })

  it('saves a new form from there', async () => {
    const user = userEvent.setup()
    const form = formWith({ link_enabled: true, record: 'tag' })
    const harness = renderWithDraft(<TestTab />, form, { isNew: true })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledWith('f_test'))
    expect(createForm).toHaveBeenCalledWith(form)
  })

  it('selects the whole test link on focus, copies it, and says Copied', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Test link' })
    await user.click(field)
    expect([field.selectionStart, field.selectionEnd]).toStrictEqual([0, LINK.length])
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await navigator.clipboard.readText()).toBe(LINK)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('copies the test link with every hidden field and the language from its menu', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }, [{ id: 'user_id' }, { id: 'app_version' }]))
    await user.click(screen.getByRole('button', { name: 'More actions for the test link' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy with hidden fields' }))
    expect(await navigator.clipboard.readText()).toBe(`${LINK}&hf_user_id={USER_ID}&hf_app_version={APP_VERSION}&lang=en`)
  })

  it('shows the test link as a QR code in a dialog, and closes it', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(screen.getByRole('button', { name: 'QR' }))
    const dialog = screen.getByRole('dialog', { name: 'Test link QR code' })
    expect(within(dialog).getByRole('img', { name: 'QR code for the Sample form feedback form' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cannot copy or draw a test link before the API address is set, and says why', async () => {
    const user = userEvent.setup()
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: '' } })
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'QR' }))
    expect(within(screen.getByRole('dialog')).getByText(/^QR code unavailable until the API endpoint is configured/)).toBeInTheDocument()
  })

  it('says when the reset failed, and keeps the old link', async () => {
    const user = userEvent.setup()
    rotateTestToken.mockRejectedValue(new Error('Network down'))
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    await user.click(screen.getByRole('button', { name: 'More actions for the test link' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reset test link…' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset test link' }))
    // (in the dialog, which stays open for another try)
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent("Couldn't reset the test link. Try again in a moment.")
    expect(screen.getByRole('textbox', { name: 'Test link' })).toHaveValue(LINK)
  })

  it('makes the test link of a form that has none yet, once the link is turned on, leaving the saved link off until Save', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: false, record: 'tag' }), { testToken: null })
    await user.click(screen.getByRole('switch', { name: 'Test link' }))
    expect(screen.getByText('This form has no test link yet.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make the test link' }))
    expect(await screen.findByRole('textbox', { name: 'Test link' })).toHaveValue('https://api.example.com/feedback-forms/f_test/iframe?test=tk_made')
    // The saved settings as they are (the link is off until Save), and no rotation: a token in use is kept.
    expect(issueTestLink).toHaveBeenCalledWith('f_test', { link_enabled: false, record: 'tag' })
    expect(rotateTestToken).not.toHaveBeenCalled()
  })

  it('says when the test link could not be made, and offers it again', async () => {
    const user = userEvent.setup()
    issueTestLink.mockRejectedValueOnce(new Error('Network down'))
    renderWithDraft(<TestTab />, formWith({ link_enabled: false, record: 'tag' }), { testToken: null })
    await user.click(screen.getByRole('switch', { name: 'Test link' }))
    await user.click(screen.getByRole('button', { name: 'Make the test link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't make the test link. Try again in a moment.")
    expect(screen.getByRole('button', { name: 'Make the test link' })).toBeInTheDocument()
  })

  it('reads the saved link\'s token before offering anything, so a link in use is never made again', async () => {
    const pending = { answer: (_state: { token: string; link_enabled: boolean; record: 'tag' | 'drop' }) => {} }
    issueTestLink.mockReturnValueOnce(new Promise((resolve) => { pending.answer = resolve }))
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }), { testToken: null })
    expect((await screen.findByText('Reading the test link…')).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('button', { name: 'Make the test link' })).not.toBeInTheDocument()
    pending.answer({ token: 'tk_live', link_enabled: true, record: 'tag' })
    expect(await screen.findByRole('textbox', { name: 'Test link' })).toHaveValue('https://api.example.com/feedback-forms/f_test/iframe?test=tk_live')
    expect(rotateTestToken).not.toHaveBeenCalled()
  })

  it('shows nothing to list under Check only', async () => {
    const user = userEvent.setup()
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'drop' }))
    expect(screen.getByRole('note')).toHaveTextContent("Check only keeps nothing, so there's nothing to show here.")
    await user.click(screen.getByRole('radio', { name: /Keep them, marked Test/ }))
    expect(await screen.findByText('No test responses yet. Open the test link, or scan its QR code on a phone, and send one.')).toBeInTheDocument()
  })
})
