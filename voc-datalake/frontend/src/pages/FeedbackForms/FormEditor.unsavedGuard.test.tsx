/**
 * The form editor dialog with the shared unsaved-changes guard (E2E F6):
 * closing it (Cancel, the X, Escape) with edits asks first; the guard's Save
 * waits for the host's save and closes only when it resolves.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import FormEditor from './FormEditor'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { ReactElement } from 'react'
import type { EditorCategory } from './FormEditorPanels'

function renderEditor(onSave = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn()
  render(<FormEditor form={null} categories={[]} onSave={onSave} onCancel={onCancel} validationPickerEnabled={false} />)
  return { user: userEvent.setup(), onSave, onCancel }
}

/** The name field starts with the blank template's name: replace it. */
async function typeName(user: ReturnType<typeof userEvent.setup>, value: string) {
  const field = screen.getByLabelText('Form Name (Internal)')
  await user.clear(field)
  await user.type(field, value)
}

const guard = () => screen.getByRole('dialog', { name: 'Unsaved changes' })
const queryGuard = () => screen.queryByRole('dialog', { name: 'Unsaved changes' })

describe('FormEditor — unsaved-changes guard', () => {
  it('closes at once on Escape when nothing was edited', async () => {
    const { user, onCancel } = renderEditor()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(queryGuard()).not.toBeInTheDocument()
  })

  it.each(['Cancel', 'Dismiss'])('asks before %s throws edits away; Cancel returns to them', async (exit) => {
    const { user, onCancel } = renderEditor()
    await typeName(user, 'e2e form')
    const editor = screen.getByRole('dialog', { name: 'Create New Feedback Form' })
    await user.click(within(editor).getByRole('button', { name: exit }))
    expect(guard()).toBeInTheDocument()
    await user.click(within(guard()).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Form Name (Internal)')).toHaveValue('e2e form')
  })

  it('Escape with edits opens the guard, and a second Escape closes only the guard', async () => {
    const { user, onCancel } = renderEditor()
    await typeName(user, 'x')
    await user.keyboard('{Escape}')
    expect(guard()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(queryGuard()).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Create New Feedback Form' })).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Discard closes without saving', async () => {
    const { user, onCancel, onSave } = renderEditor()
    await typeName(user, 'x')
    await user.keyboard('{Escape}')
    await user.click(within(guard()).getByRole('button', { name: 'Discard' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("Save runs the host's save with the edits, then closes", async () => {
    const { user, onCancel, onSave } = renderEditor()
    await typeName(user, 'e2e form')
    await user.keyboard('{Escape}')
    await user.click(within(guard()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'e2e form' }))
  })

  it('a rejected save keeps both dialogs open and says so', async () => {
    const { user, onCancel } = renderEditor(vi.fn().mockRejectedValue(new Error('500')))
    await typeName(user, 'x')
    await user.keyboard('{Escape}')
    await user.click(within(guard()).getByRole('button', { name: 'Save' }))
    expect(await within(guard()).findByRole('alert')).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('FormEditor — the shared Cancel-keeps-the-draft contract (3.00.00 R2)', () => {
  it('keeps the edit and stays guarded when the host re-renders with fresh data while the dialog is open', async () => {
    const onCancel = vi.fn()
    const editor = (categories: ReadonlyArray<EditorCategory>) => (
      <FormEditor form={null} categories={categories} onSave={vi.fn().mockResolvedValue(undefined)} onCancel={onCancel} validationPickerEnabled={false} />
    )
    const view: { rerender?: (ui: ReactElement) => void } = {}
    await expectCancelKeepsDraftGuarded({
      mount: () => { view.rerender = render(editor([])).rerender },
      edit: (user) => typeName(user, 'e2e form'),
      expectDraft: () => expect(screen.getByLabelText('Form Name (Internal)')).toHaveValue('e2e form'),
      leave: async (user) => {
        await user.click(within(screen.getByRole('dialog', { name: 'Create New Feedback Form' })).getByRole('button', { name: 'Cancel' }))
      },
      expectStayed: () => {
        expect(onCancel).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'Create New Feedback Form' })).toBeInTheDocument()
      },
      expectLeft: () => expect(onCancel).toHaveBeenCalledTimes(1),
      // The page's categories query refetched: the host hands over a new array.
      whileDialogOpen: async () => { view.rerender?.(editor([{ id: 'delivery', name: 'Delivery', subcategories: [] }])) },
    })
  })
})
