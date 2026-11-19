/**
 * The Questions tab's Style panel (preview/StylePanel): from xl in the editor's column, its heading taking the focus
 * and "Back to question" giving it back to what opened it; below xl a dialog with the phone at its top. Both hold the
 * draft's theme editor, which tells the preview the palette it is editing.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { StyleColumn, StyleSheet } from './StylePanel'

vi.mock('./PreviewFrame', () => import('../test/previewFrameStub'))

describe('StyleColumn', () => {
  it('takes the focus to its heading, holds the theme editor, and Back to question goes back', async () => {
    const onBack = vi.fn<() => void>()
    const onScheme = vi.fn<(scheme: 'light' | 'dark' | null) => void>()
    renderWithDraft(<StyleColumn onBack={onBack} onEditingSchemeChange={onScheme} />)
    expect(screen.getByRole('heading', { name: 'Style', level: 2 })).toHaveFocus()
    expect(screen.getByRole('region', { name: 'Style' })).toContainElement(screen.getByRole('group', { name: 'Mode' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to question' }))
    expect([onBack.mock.calls.length, onScheme.mock.calls[0]]).toStrictEqual([1, ['light']])
  })

  it('gives the focus back to what opened it when it goes with the focus inside', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = renderWithDraft(<StyleColumn onBack={vi.fn()} onEditingSchemeChange={vi.fn()} />)
    expect(opener).not.toHaveFocus()
    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

describe('StyleSheet', () => {
  it('is a dialog with the phone, in the palette being edited, above the theme editor', () => {
    const form = sampleForm()
    renderWithDraft(<StyleSheet isOpen onClose={vi.fn()} form={form} scheme="dark" onEditingSchemeChange={vi.fn()} />, form)
    const dialog = screen.getByRole('dialog', { name: 'Style' })
    expect(dialog).toContainElement(screen.getByRole('region', { name: 'Form preview, phone size, English' }))
    expect(dialog).toContainElement(screen.getByRole('group', { name: 'Mode' }))
  })

  it('renders nothing while closed', () => {
    const form = sampleForm()
    renderWithDraft(<StyleSheet isOpen={false} onClose={vi.fn()} form={form} scheme={null} onEditingSchemeChange={vi.fn()} />, form)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
