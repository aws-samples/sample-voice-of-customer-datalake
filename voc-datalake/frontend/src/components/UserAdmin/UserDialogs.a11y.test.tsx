/**
 * @fileoverview The two user-admin dialogs are real modal dialogs (E2E F5 audit).
 *
 * Both used to be a bare `dialog-overlay` div: no `role="dialog"`, no accessible
 * name, no focus trap (Escape alone came from `useEscapeKey`). They now render
 * through ModalShell like every other dialog in the app.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { cognitoUser } from './userAdmin-fixtures'

vi.mock('../../api/client', () => ({
  api: {
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}))

import CreateUserModal from './CreateUserModal'
import EditUserModal from './EditUserModal'

const CASES = [
  {
    name: 'Add New User',
    render: (onClose: () => void) =>
      renderWithQueryClient(<CreateUserModal isOpen onClose={onClose} onSuccess={vi.fn()} />),
  },
  {
    name: 'Edit User',
    render: (onClose: () => void) =>
      renderWithQueryClient(
        <EditUserModal isOpen user={cognitoUser({ username: 'u-1', given_name: 'Ann' })} onClose={onClose} onSuccess={vi.fn()} />,
      ),
  },
] as const

/** The focused element, as an HTMLElement or null (never an `as` cast). */
function focused(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

describe.each(CASES)('$name dialog', ({ name, render }) => {
  it('is a named modal dialog', () => {
    render(vi.fn())

    expect(screen.getByRole('dialog', { name })).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape, once', async () => {
    const onClose = vi.fn()
    render(onClose)

    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps focus inside the dialog however far Tab goes', async () => {
    render(vi.fn())
    const dialog = screen.getByRole('dialog', { name })

    await Array.from({ length: 10 }).reduce<Promise<void>>((done) => done.then(() => userEvent.tab()), Promise.resolve())

    expect(dialog).toContainElement(focused())
  })
})
