/**
 * The Test tab (UX §9.1): the test link with its token, Keep / Check only, the reset and the delete (each asked
 * first), and the recent test responses with their hidden values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const rotateTestToken = vi.fn<(formId: string) => Promise<string>>()
const deleteTestResponses = vi.fn<(formId: string) => Promise<number>>()
const getResponses = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return {
    ...actual,
    feedbackFormsV2Api: {
      ...actual.feedbackFormsV2Api,
      rotateTestToken: (formId: string) => rotateTestToken(formId),
      deleteTestResponses: (formId: string) => deleteTestResponses(formId),
      getResponses: (...args: unknown[]) => getResponses(...args),
    },
  }
})

import { useConfigStore } from '../../../store/configStore'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { FormV2 } from '../model/formsV2'
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
    deleteTestResponses.mockResolvedValue(2)
  })

  it('shows the test link with the form test token while the link is on', () => {
    renderWithDraft(<TestTab />, formWith({ link_enabled: true, record: 'tag' }))
    expect(screen.getByRole('textbox', { name: 'Test link' })).toHaveValue(LINK)
    expect(screen.getByRole('button', { name: 'QR' })).toBeInTheDocument()
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
    expect(rotateTestToken).toHaveBeenCalledWith('f_test')
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
})
