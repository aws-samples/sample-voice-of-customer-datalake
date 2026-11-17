/**
 * People → a person's editor sheet: the name (its own "Save name", the server's refusal in words), the stored category
 * and source access with "Change access…" opening the Category access dialog over the sheet, the account actions
 * (each confirmed, then said in the sheet's status line until the next edit) and "Delete <name>…" at the foot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { mount, personRow, primeUserClient } from './userAdmin-sheet-fixtures'
import type { CognitoUser } from '../../api/types'

const client = await vi.hoisted(async () => (await import('./userAdmin-sheet-fixtures')).createUserClientMock())
vi.mock('../../api/client', () => client.module)
vi.mock('../../store/authStore', () => ({ useIsPlatformAdmin: () => false }))

const { default: UserEditorSheet } = await import('./UserEditorSheet')

const grace = personRow('grace', { given_name: 'Grace', family_name: 'Hopper' })

function openSheet(user: CognitoUser = grace) {
  const onDeleted = vi.fn()
  const session = mount(<UserEditorSheet user={user} onClose={vi.fn()} onDeleted={onDeleted} />)
  return { session, onDeleted }
}

const sheet = () => screen.getByRole('dialog', { name: 'Edit Grace Hopper' })
const sheetStatus = () => within(sheet()).getAllByRole('status').at(-1)
const firstName = () => within(sheet()).getByRole('textbox', { name: 'First Name' })

beforeEach(() => { primeUserClient(client) })

describe('name', () => {
  it('saves the edited name and says Saved', async () => {
    const { session } = openSheet()
    await session.type(firstName(), 'y')

    await session.click(within(sheet()).getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(client.api.updateUser).toHaveBeenCalledWith('grace', { given_name: 'Gracey', family_name: 'Hopper' }))
    await waitFor(() => expect(sheetStatus()).toHaveTextContent('Saved'))
  })

  it('offers no save while the name is unchanged or empty', async () => {
    const { session } = openSheet()
    const save = within(sheet()).getByRole('button', { name: 'Save name' })
    expect(save).toBeDisabled()

    await session.clear(firstName())
    await session.clear(within(sheet()).getByRole('textbox', { name: 'Last Name' }))

    expect(save).toBeDisabled()
  })

  it('says the server\'s reason when the name is refused', async () => {
    client.api.updateUser.mockResolvedValue({ success: false, message: 'Name too long' })
    const { session } = openSheet()
    await session.type(firstName(), 'y')

    await session.click(within(sheet()).getByRole('button', { name: 'Save name' }))

    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('Name too long')
  })
})

describe('category and source access', () => {
  it('summarises the stored rule and opens Category access over the sheet', async () => {
    const { session } = openSheet()

    expect(await within(sheet()).findByText('Categories: all')).toBeInTheDocument()
    await session.click(within(sheet()).getByRole('button', { name: 'Change access…' }))

    expect(await screen.findByRole('dialog', { name: 'Category access' })).toBeInTheDocument()
  })
})

describe('account actions', () => {
  it.each([
    ['Reset password…', 'Send Reset Email', 'resetUserPassword', 'Password reset email sent'],
    ['Disable sign-in…', 'Disable', 'disableUser', 'User disabled'],
  ] as const)('%s asks first, then says what it did until the next edit', async (button, confirm, route, said) => {
    const { session } = openSheet()

    await session.click(within(sheet()).getByRole('button', { name: button }))
    await session.click(await screen.findByRole('button', { name: confirm }))

    await waitFor(() => expect(client.api[route]).toHaveBeenCalledWith('grace'))
    await waitFor(() => expect(sheetStatus()).toHaveTextContent(said))
    await session.type(firstName(), 'y')
    expect(within(sheet()).queryByText(said)).not.toBeInTheDocument()
  })

  it('offers Enable for a disabled person', async () => {
    const { session } = openSheet(personRow('grace', { given_name: 'Grace', family_name: 'Hopper', enabled: false }))

    await session.click(within(sheet()).getByRole('button', { name: 'Enable sign-in…' }))
    await session.click(await screen.findByRole('button', { name: 'Enable' }))

    await waitFor(() => expect(client.api.enableUser).toHaveBeenCalledWith('grace'))
  })

  it('says when an action did not go through', async () => {
    client.api.resetUserPassword.mockRejectedValue(new Error('boom'))
    const { session } = openSheet()

    await session.click(within(sheet()).getByRole('button', { name: 'Reset password…' }))
    await session.click(await screen.findByRole('button', { name: 'Send Reset Email' }))

    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('That did not go through. Try again.')
  })
})

describe('delete', () => {
  it('sits at the foot, asks first and tells the page once the person is gone', async () => {
    const { session, onDeleted } = openSheet()

    await session.click(within(sheet()).getByRole('button', { name: 'Delete Grace Hopper…' }))
    expect(await screen.findByText(/Are you sure you want to delete grace@example.com/)).toBeInTheDocument()
    await session.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('User deleted'))
    expect(client.api.deleteUser).toHaveBeenCalledWith('grace')
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const { session } = openSheet()

    await session.click(within(sheet()).getByRole('button', { name: 'Delete Grace Hopper…' }))
    await session.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(client.api.deleteUser).not.toHaveBeenCalled()
  })
})
