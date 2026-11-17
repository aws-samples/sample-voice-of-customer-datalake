/**
 * People → a person's editor sheet: one dialog named "Edit <name>" that holds every per-person setting, each section
 * saving itself (one PUT per change), ONE "Saved" status for the sheet that stays until the next edit (never a
 * timer), the fallback-owner and platform-admin rules said beside their boxes, the server's refusals in words, and
 * Delete at the foot through a confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../../lib/errors'
import { mount, personRow, primeUserClient } from './userAdmin-sheet-fixtures'
import type { CognitoUser } from '../../api/types'

const client = await vi.hoisted(async () => (await import('./userAdmin-sheet-fixtures')).createUserClientMock())
const platform = vi.hoisted(() => ({ isPlatformAdmin: false }))
vi.mock('../../api/client', () => client.module)
vi.mock('../../store/authStore', () => ({ useIsPlatformAdmin: () => platform.isPlatformAdmin }))

const { default: UserEditorSheet } = await import('./UserEditorSheet')

const ada = personRow('ada', { given_name: 'Ada', family_name: 'Lovelace', groups: ['admins'] })
const vic = personRow('vic')

function openSheet(user: CognitoUser = vic, onDeleted = vi.fn()) {
  const session = mount(<UserEditorSheet user={user} onClose={vi.fn()} onDeleted={onDeleted} />)
  return { session, onDeleted }
}

const sheet = () => screen.getByRole('dialog', { name: /^Edit / })
const status = () => within(sheet()).getAllByRole('status').at(-1)

beforeEach(() => {
  platform.isPlatformAdmin = false
  primeUserClient(client)
})

describe('the sheet', () => {
  it('is named after the person, with their email under the title', () => {
    openSheet(ada)

    expect(screen.getByRole('dialog', { name: 'Edit Ada Lovelace' })).toHaveTextContent('ada@example.com')
    expect(within(sheet()).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toStrictEqual([
      'Role', 'Way of working with AI', 'Category and source access', 'Memory and ownership', 'Name', 'Account',
    ])
  })

  it('names a person without a name by their email', () => {
    openSheet()

    expect(screen.getByRole('dialog', { name: 'Edit vic@example.com' })).toBeInTheDocument()
  })
})

describe('role', () => {
  it('PUTs the new role and then says Saved, until the next edit', async () => {
    const { session } = openSheet()

    await session.selectOptions(within(sheet()).getByRole('combobox', { name: 'Role' }), 'admins')

    await waitFor(() => expect(client.api.updateUserGroup).toHaveBeenCalledWith('vic', 'admins'))
    await waitFor(() => expect(status()).toHaveTextContent('Saved'))
    await session.type(within(sheet()).getByRole('textbox', { name: 'First Name' }), 'V')
    expect(within(sheet()).queryByText('Saved')).not.toBeInTheDocument()
  })

  it('says when the role could not be changed', async () => {
    client.api.updateUserGroup.mockResolvedValue({ success: false, message: 'nope' })
    const { session } = openSheet()

    await session.selectOptions(within(sheet()).getByRole('combobox', { name: 'Role' }), 'admins')

    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('Could not change the role. Try again.')
  })
})

describe('memory and ownership flags', () => {
  it('reflects the stored flags, a missing block reading as off', () => {
    openSheet(personRow('ada', { groups: ['admins'], flags: { fallback_owner: true, memory_reviewer: false } }))

    expect(screen.getByRole('checkbox', { name: 'Fallback owner' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Memory reviewer' })).not.toBeChecked()
  })

  it('locks fallback owner for a non-admin and says why, beside the box', () => {
    openSheet()

    expect(screen.getByRole('checkbox', { name: 'Fallback owner' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Fallback owner' })).toHaveAccessibleDescription('Only an admin can be the fallback owner.')
  })

  it('keeps fallback owner clearable on a non-admin who still holds it', () => {
    openSheet(personRow('vic', { flags: { fallback_owner: true } }))

    expect(screen.getByRole('checkbox', { name: 'Fallback owner' })).toBeEnabled()
  })

  it('PUTs the one flag that changed, for an admin\'s fallback owner too', async () => {
    const { session } = openSheet(ada)

    await session.click(screen.getByRole('checkbox', { name: 'Fallback owner' }))

    await waitFor(() => expect(client.fetchApi).toHaveBeenCalledWith('/users/ada/flags', { method: 'PUT', body: '{"fallback_owner":true}' }))
  })

  it('says when a flag could not be saved', async () => {
    client.fetchApi.mockImplementation((endpoint) => (endpoint.endsWith('/flags') ? Promise.reject(new Error('boom')) : Promise.resolve({})))
    const { session } = openSheet()

    await session.click(screen.getByRole('checkbox', { name: 'Memory reviewer' }))

    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('Could not update the flag. Try again.')
  })
})

describe('platform admin', () => {
  it('is shown to platform admins only', () => {
    openSheet(ada)

    expect(screen.queryByRole('checkbox', { name: 'Platform admin' })).not.toBeInTheDocument()
  })

  it('is offered to an administrator, and locked for anyone else with the reason as its description', () => {
    platform.isPlatformAdmin = true
    openSheet()

    expect(screen.getByRole('checkbox', { name: 'Platform admin' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Platform admin' })).toHaveAccessibleDescription('Only an administrator can be a platform admin.')
  })

  it('grants through PUT /users/{username}/platform-admin', async () => {
    platform.isPlatformAdmin = true
    const { session } = openSheet(ada)

    await session.click(screen.getByRole('checkbox', { name: 'Platform admin' }))

    await waitFor(() => expect(client.api.setPlatformAdmin).toHaveBeenCalledWith('ada', true))
  })

  it('says why revoking the last platform admin was refused', async () => {
    platform.isPlatformAdmin = true
    client.api.setPlatformAdmin.mockRejectedValue(new ApiError(409, 'This is the last enabled platform admin: make another administrator a platform admin first.'))
    const { session } = openSheet(personRow('ada', { groups: ['admins'], platform_admin: true }))

    await session.click(screen.getByRole('checkbox', { name: 'Platform admin' }))

    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('This is the last enabled platform admin: make another administrator a platform admin first.')
  })
})
