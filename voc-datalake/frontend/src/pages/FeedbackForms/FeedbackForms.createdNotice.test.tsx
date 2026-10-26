/**
 * New forms are created disabled; the page says so right after the create and
 * offers "Enable now" (E2E F6: a fresh form's link answered "Feedback form
 * unavailable." and nothing on the page explained why).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { feedbackFormsApiMocks, clientApiModule, configStoreModule, createFormsWrapper } from './feedback-forms-fixtures'

vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../store/configStore', () => configStoreModule())

vi.mock('./TemplateWizard', () => ({
  default: ({ onSelect }: { onSelect: (config: unknown) => void }) => (
    <button type="button" onClick={() => onSelect({ name: 'NPS Survey', enabled: false })}>Select Template</button>
  ),
}))

// The editor saves whatever it was opened with: an existing form (edit) or the
// template config (create).
vi.mock('./FormEditor', () => ({
  default: ({ form, initialConfig, onSave }: {
    form: Record<string, unknown> | null
    initialConfig: Record<string, unknown> | null
    onSave: (form: unknown) => void
  }) => (
    <button type="button" onClick={() => onSave(form ?? initialConfig)}>Save form</button>
  ),
}))

vi.mock('./FormCard', () => ({
  default: ({ form, onEdit }: { form: { form_id: string; name: string }; onEdit: (f: unknown) => void }) => (
    <button type="button" onClick={() => onEdit(form)}>Edit {form.name}</button>
  ),
}))

import FeedbackForms from './FeedbackForms'

const { getFeedbackForms, createFeedbackForm, updateFeedbackForm, getCategoriesConfig } = feedbackFormsApiMocks
const NOTICE = '“NPS Survey” was created and is disabled: anyone opening its link sees “Feedback form unavailable.” until you enable it.'

async function createForm(response: unknown): Promise<void> {
  createFeedbackForm.mockResolvedValue(response)
  const user = userEvent.setup()
  render(<FeedbackForms />, { wrapper: createFormsWrapper() })
  await user.click(screen.getByRole('button', { name: /create form/i }))
  await user.click(screen.getByRole('button', { name: 'Select Template' }))
  await user.click(screen.getByRole('button', { name: 'Save form' }))
}

describe('FeedbackForms: a just-created disabled form is announced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getFeedbackForms.mockResolvedValue({ forms: [] })
    getCategoriesConfig.mockResolvedValue({ categories: [] })
    updateFeedbackForm.mockResolvedValue({ success: true })
  })

  it('says the new form is disabled and what its link shows', async () => {
    await createForm({ success: true, form: { form_id: 'f-new', name: 'NPS Survey', enabled: false } })

    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('NPS Survey')
  })

  it('"Enable now" enables exactly that form and clears the notice', async () => {
    await createForm({ success: true, form: { form_id: 'f-new', name: 'NPS Survey', enabled: false } })

    await userEvent.click(await screen.findByRole('button', { name: 'Enable now' }))

    expect(updateFeedbackForm).toHaveBeenCalledWith('f-new', { enabled: true })
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument())
  })

  it('announces nothing when the form was created enabled', async () => {
    await createForm({ success: true, form: { form_id: 'f-new', name: 'NPS Survey', enabled: true } })

    await waitFor(() => expect(createFeedbackForm).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Enable now' })).not.toBeInTheDocument()
  })

  it('announces nothing after an edit, even of a disabled form', async () => {
    getFeedbackForms.mockResolvedValue({ forms: [{ form_id: 'f-1', name: 'Old', enabled: false }] })
    updateFeedbackForm.mockResolvedValue({ success: true, form: { form_id: 'f-1', name: 'Old', enabled: false } })
    const user = userEvent.setup()
    render(<FeedbackForms />, { wrapper: createFormsWrapper() })

    await user.click(await screen.findByRole('button', { name: 'Edit Old' }))
    await user.click(screen.getByRole('button', { name: 'Save form' }))

    await waitFor(() => expect(updateFeedbackForm).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Enable now' })).not.toBeInTheDocument()
  })
})
