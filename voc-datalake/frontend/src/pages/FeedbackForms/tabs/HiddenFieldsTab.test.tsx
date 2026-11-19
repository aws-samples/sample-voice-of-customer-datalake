import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HiddenFieldsTab from './HiddenFieldsTab'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { FormV2 } from '../model/formsV2'

vi.mock('../../../store/configStore', async () => (await import('../feedback-forms-fixtures')).configStoreModule())
vi.mock('../../../hooks/useDimensions', () => ({
  useDimensionsConfig: () => ({ data: { dimensions: [{ key: 'app_version', label: 'App version', infer: false, values: [] }] } }),
}))

const withHidden = (overrides: Partial<FormV2> = {}): FormV2 => sampleForm({
  hidden_fields: [{ id: 'user_id', label: 'User' }, { id: 'app_version' }], ...overrides,
})

const codeText = () => screen.getByRole('region', { name: 'Link code' }).textContent

describe('HiddenFieldsTab: declare hidden fields, then copy the link or code that fills them', () => {
  it('checks a new ID as it is typed', async () => {
    const user = userEvent.setup()
    renderWithDraft(<HiddenFieldsTab />, withHidden())
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    const id = screen.getByLabelText('ID')
    expect(id).toHaveFocus()
    await user.type(id, '1abc')
    expect(screen.getByText('Start with a letter; use lower-case letters, digits and _.')).toBeInTheDocument()
    await user.clear(id)
    await user.type(id, 'user_id')
    expect(screen.getByText('Already used in this form.')).toBeInTheDocument()
  })

  it('refuses a name the widget never fills, as the server does, and adds nothing', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<HiddenFieldsTab />, withHidden())
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    await user.type(screen.getByLabelText('ID'), 'constructor')
    expect(screen.getByText('constructor is a reserved name; choose another.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(harness.probe.current?.form.hidden_fields).toStrictEqual(withHidden().hidden_fields)
  })

  it('adds a field with its label', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<HiddenFieldsTab />, withHidden())
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    await user.type(screen.getByLabelText('ID'), 'screen')
    await user.type(screen.getByLabelText('Label'), 'Screen')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(harness.probe.current?.form.hidden_fields.at(-1)).toStrictEqual({ id: 'screen', label: 'Screen' })
    expect(screen.getByText('3 of 20 · Each value is text, up to 200 characters; longer values are cut.')).toBeInTheDocument()
  })

  it('deletes a field after asking', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<HiddenFieldsTab />, withHidden())
    await user.click(screen.getByRole('button', { name: 'More actions for user_id' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete “user_id”?' })
    expect(within(dialog).getByText('Values already received stay in Results.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(harness.probe.current?.form.hidden_fields).toStrictEqual([{ id: 'app_version' }])
  })

  it('says which field also files a configured dimension', () => {
    renderWithDraft(<HiddenFieldsTab />, withHidden())
    expect(screen.getByText('filter, column and the dimension App version*')).toBeInTheDocument()
  })

  it('builds the link with every hidden field as a placeholder and the form’s language', () => {
    renderWithDraft(<HiddenFieldsTab />, withHidden())
    expect(codeText()).toContain('/feedback-forms/f_test/iframe?hf_user_id={USER_ID}&hf_app_version={APP_VERSION}&lang=en')
  })

  it('shows the test link, and says its responses are never counted, when Test is picked', async () => {
    const user = userEvent.setup()
    renderWithDraft(<HiddenFieldsTab />, withHidden({ settings: { test: { link_enabled: true, record: 'tag' } } }))
    // ("Values for" Live | Test is its own named control, on its own line under the kind of snippet)
    const valuesFor = screen.getByRole('group', { name: 'Values for' })
    expect(valuesFor.parentElement).not.toContainElement(screen.getByRole('group', { name: 'Where the values come from' }))
    await user.click(within(valuesFor).getByRole('button', { name: 'Test' }))
    expect(codeText()).toContain('iframe?test=tk_test&hf_user_id={USER_ID}')
    expect(screen.getByText('This is the test link: responses are marked Test and never counted.')).toBeInTheDocument()
  })

  it('sends people to Test when the test link is off', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<HiddenFieldsTab />, withHidden())
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(screen.getByText('Turn on the test link in Test first.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Test' }))
    expect(harness.go).toHaveBeenCalledWith('test')
  })

  it('has no links for a form that was never saved', () => {
    renderWithDraft(<HiddenFieldsTab />, withHidden(), { isNew: true })
    expect(screen.getByText('Save the form to get its links.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Link code' })).not.toBeInTheDocument()
  })

  it('invites a first field when there is none', () => {
    renderWithDraft(<HiddenFieldsTab />, sampleForm())
    expect(screen.getByText('Add one to receive values such as a user id or the app version from your app.')).toBeInTheDocument()
  })

  it('holds Add field at 20, and says why', () => {
    const twenty = Array.from({ length: 20 }, (_unused, index) => ({ id: `field_${String(index)}` }))
    renderWithDraft(<HiddenFieldsTab />, sampleForm({ hidden_fields: twenty }))
    expect(screen.getByRole('button', { name: 'Add field' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('A form has up to 20 hidden fields.')).toBeInTheDocument()
  })

  it('locks a field’s ID once the form has a real response', async () => {
    const user = userEvent.setup()
    renderWithDraft(<HiddenFieldsTab />, withHidden(), { meta: { has_responses: true } })
    await user.click(screen.getByRole('button', { name: 'More actions for user_id' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByLabelText('ID')).toHaveAttribute('readonly')
  })
})
