/**
 * The side sheet: a named modal dialog at the inline end (ModalShell's `end` placement and `.sheet-panel`), whose
 * header, body and footer are the dialog recipes; Escape and its close button close it, focus stays inside, and
 * focus returns to what opened it.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import SideSheet from './SideSheet'

function Host({ onClose = vi.fn() }: Readonly<{ onClose?: () => void }>) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Edit Ada</button>
      <SideSheet isOpen={open} onClose={() => { onClose(); setOpen(false) }} title="Edit Ada" description="ada@example.com"
        footer={<button type="button">Delete Ada…</button>}>
        <label>Name <input /></label>
      </SideSheet>
    </>
  )
}

/** The focused element, as an HTMLElement or null. */
const focused = (): HTMLElement | null => (document.activeElement instanceof HTMLElement ? document.activeElement : null)

describe('SideSheet', () => {
  it('is a modal dialog named by its title, at the end, with the dialog recipes', async () => {
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ada' }))

    const sheet = screen.getByRole('dialog', { name: 'Edit Ada' })
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(sheet).toHaveClass('sheet-panel')
    expect(sheet.parentElement).toHaveClass('justify-end', 'items-stretch')
    expect([sheet.querySelector('.dialog-header'), sheet.querySelector('.dialog-body'), sheet.querySelector('.dialog-footer')]
      .every((part) => part !== null)).toBe(true)
  })

  it('shows its description under the title', async () => {
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ada' }))

    expect(screen.getByText('ada@example.com')).toHaveClass('dialog-description')
  })

  it('closes on Escape and on its close button, returning the focus to what opened it', async () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Edit Ada' })

    await userEvent.click(opener)
    await userEvent.keyboard('{Escape}')
    expect(focused()).toBe(opener)
    await userEvent.click(opener)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('keeps the focus inside however far Tab goes', async () => {
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ada' }))
    const sheet = screen.getByRole('dialog', { name: 'Edit Ada' })

    await Array.from({ length: 5 }).reduce<Promise<void>>((done) => done.then(() => userEvent.tab()), Promise.resolve())

    expect(sheet).toContainElement(focused())
  })

  it('renders no footer when it has none', () => {
    render(<SideSheet isOpen onClose={vi.fn()} title="Details"><p>Body</p></SideSheet>)

    expect(screen.getByRole('dialog', { name: 'Details' }).querySelector('.dialog-footer')).toBeNull()
  })

  it('is 30rem wide from sm by default and 44rem when it holds a document (size="wide")', () => {
    const { rerender } = render(<SideSheet isOpen onClose={vi.fn()} title="Details"><p>Body</p></SideSheet>)
    expect(screen.getByRole('dialog', { name: 'Details' })).not.toHaveClass('sm:max-w-[44rem]')

    rerender(<SideSheet isOpen onClose={vi.fn()} title="Details" size="wide"><p>Body</p></SideSheet>)
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveClass('sheet-panel', 'sm:max-w-[44rem]')
  })
})
