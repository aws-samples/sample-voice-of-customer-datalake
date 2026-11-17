/**
 * @fileoverview The People dialogs are real modal dialogs (E2E F5 audit): the invite dialog and a person's editor
 * sheet are each named, close on Escape once and keep the focus inside, through ModalShell like every other dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { cognitoUser } from './userAdmin-fixtures'
import { primeUserClient } from './userAdmin-sheet-fixtures'

const client = await vi.hoisted(async () => (await import('./userAdmin-sheet-fixtures')).createUserClientMock())
vi.mock('../../api/client', () => client.module)
vi.mock('../../store/authStore', () => ({ useIsPlatformAdmin: () => false }))

const { default: CreateUserModal } = await import('./CreateUserModal')
const { default: UserEditorSheet } = await import('./UserEditorSheet')

const CASES = [
  {
    name: 'Invite person',
    render: (onClose: () => void) =>
      renderWithQueryClient(<CreateUserModal isOpen onClose={onClose} onSuccess={vi.fn()} />),
  },
  {
    name: 'Edit Ann',
    render: (onClose: () => void) =>
      renderWithQueryClient(<UserEditorSheet user={cognitoUser({ username: 'u-1', given_name: 'Ann' })} onClose={onClose} onDeleted={vi.fn()} />),
  },
] as const

/** The focused element, as an HTMLElement or null (never an `as` cast). */
function focused(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

beforeEach(() => { primeUserClient(client) })

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
