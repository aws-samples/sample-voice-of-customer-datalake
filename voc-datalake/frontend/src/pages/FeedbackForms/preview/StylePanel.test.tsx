/**
 * The Questions tab's Style panel (audit §2.1): from xl, in the editor's column (the focus goes to its heading, Back to
 * question returns, and the focus goes back to what opened it); below xl, a side sheet with the phone at its top. Both
 * hold the form's theme editor, which tells the preview the palette being edited.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('./PreviewFrame', () => import('../test/previewFrameStub'))
vi.mock('../theme/useFormBrand', async (importOriginal) => ({
  ...await importOriginal<typeof import('../theme/useFormBrand')>(),
  useFormBrand: () => ({ brand: null, canSave: false, save: vi.fn(), saving: false, saved: false, failed: false }),
}))

import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { StyleColumn, StyleSheet } from './StylePanel'

afterEach(() => { vi.clearAllMocks() })

/** The preview toolbar's Style button and the column it opens (Back to question closes it). */
function OpenerAndColumn() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { setOpen(true) }}>Style</button>
      {open && <StyleColumn onBack={() => { setOpen(false) }} onEditingSchemeChange={vi.fn()} />}
    </>
  )
}

describe('the Style panel in the editor column', () => {
  it('takes the focus to its heading and goes back on Back to question', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn<() => void>()
    const onScheme = vi.fn<(scheme: 'light' | 'dark' | null) => void>()
    renderWithDraft(<StyleColumn onBack={onBack} onEditingSchemeChange={onScheme} />)
    const panel = screen.getByRole('region', { name: 'Style' })
    expect(within(panel).getByRole('heading', { name: 'Style' })).toHaveFocus()
    await user.click(within(panel).getByRole('button', { name: 'Back to question' }))
    expect(onBack).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
  })

  it('tells the preview which palette is being edited', async () => {
    const user = userEvent.setup()
    const onScheme = vi.fn<(scheme: 'light' | 'dark' | null) => void>()
    renderWithDraft(<StyleColumn onBack={vi.fn()} onEditingSchemeChange={onScheme} />)
    await user.click(within(screen.getByRole('group', { name: 'Mode' })).getByRole('button', { name: 'Dark' }))
    expect(onScheme).toHaveBeenLastCalledWith('dark')
  })

  it('gives the focus back to the Style button when Back to question closes it', async () => {
    const user = userEvent.setup()
    renderWithDraft(<OpenerAndColumn />)
    const opener = screen.getByRole('button', { name: 'Style' })
    await user.click(opener)
    expect(screen.getByRole('heading', { name: 'Style' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Back to question' }))
    expect(screen.queryByRole('region', { name: 'Style' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})

describe('the Style panel as a side sheet', () => {
  it('shows the phone preview in the form\'s language above the theme editor, and closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn<() => void>()
    const form = sampleForm()
    renderWithDraft(<StyleSheet isOpen onClose={onClose} form={form} scheme="dark" onEditingSchemeChange={vi.fn()} />, form)
    const sheet = screen.getByRole('dialog', { name: 'Style' })
    const phone = within(sheet).getByTestId('preview-frame')
    expect(phone).toHaveAccessibleName('Form preview, phone size, English')
    expect(phone).toHaveAttribute('lang', form.language)
    expect(within(sheet).getByRole('group', { name: 'Mode' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledWith()
  })

  it('renders nothing while closed', () => {
    renderWithDraft(<StyleSheet isOpen={false} onClose={vi.fn()} form={sampleForm()} scheme={null} onEditingSchemeChange={vi.fn()} />)
    expect(screen.queryByRole('dialog', { name: 'Style' })).not.toBeInTheDocument()
  })
})
