/**
 * Administration → People: one list (Name, Role, Way of working, Flags, Status) with an Edit per row, the page's one
 * primary "Invite person", and the open item the host's path names (`openItem`: a username opens that person's editor
 * sheet, `invite` the invite dialog); every open and close goes through `onOpenItem`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import type { CognitoUser } from '../../api/types'
import { mount, personRow, primeUserClient } from './userAdmin-sheet-fixtures'

const client = await vi.hoisted(async () => (await import('./userAdmin-sheet-fixtures')).createUserClientMock())
vi.mock('../../api/client', () => client.module)
vi.mock('../../store/authStore', () => ({ useIsPlatformAdmin: () => false }))

const { default: UserAdmin } = await import('./UserAdmin')

const ADA = personRow('ada', {
  given_name: 'Ada', family_name: 'Lovelace', groups: ['admins'], platform_admin: true,
  flags: { fallback_owner: true, memory_reviewer: true },
  ai_mode: { mode: 'ai_assisted', ai_writing_prfaq: false, ai_writing_prd: false, saved: true },
})
const VIC = personRow('vic', { enabled: false })

function renderPeople(users: readonly CognitoUser[] = [ADA, VIC], openItem: string | null = null) {
  primeUserClient(client, users)
  const onOpenItem = vi.fn<(item: string | null) => void>()
  const session = mount(<UserAdmin openItem={openItem} onOpenItem={onOpenItem} />)
  return { session, onOpenItem }
}

/** The desktop table (the cards repeat every row for narrow screens). */
const table = async () => screen.findByRole('table')
const rowOf = async (name: string) => within(await table()).getByRole('row', { name: new RegExp(name) })

beforeEach(() => { primeUserClient(client) })

describe('the list', () => {
  it('has the five columns, then Edit', async () => {
    renderPeople()

    expect(within(await table()).getAllByRole('columnheader').map((cell) => cell.textContent))
      .toStrictEqual(['Name', 'Role', 'Way of working', 'Flags', 'Status', 'Actions'])
  })

  it('shows a person\'s role, saved way of working, flags and status in their row', async () => {
    renderPeople()

    const row = within(await rowOf('Ada Lovelace'))
    expect(row.getByText('Admin')).toBeInTheDocument()
    expect(row.getByText('AI-assisted')).toBeInTheDocument()
    expect(['Fallback owner', 'Memory reviewer', 'Platform admin', 'Active'].map((text) => row.getByText(text).className))
      .toStrictEqual(['badge badge-muted', 'badge badge-muted', 'badge badge-muted', 'badge badge-ok'])
  })

  it('marks a way of working nobody saved "Not set", and a disabled person Disabled', async () => {
    renderPeople()

    const row = within(await rowOf('vic@example.com'))
    expect(row.getByText('Not set')).toHaveClass('badge-warn')
    expect(row.getByText('Disabled')).toHaveClass('badge-danger')
    expect(row.getByText('None')).toBeInTheDocument()
  })

  it.each([
    ['Pending', { status: 'FORCE_CHANGE_PASSWORD' }],
    ['UNKNOWN', { status: 'UNKNOWN' }],
  ] as const)('shows %s for a person in that state', async (badge, overrides) => {
    renderPeople([personRow('pat', overrides)])

    expect(within(await table()).getByText(badge)).toHaveClass('badge')
  })

  it('counts the people and says when there is nobody', async () => {
    renderPeople([])

    expect(await screen.findByText('0 people')).toBeInTheDocument()
    expect(screen.getAllByText('No one has been invited yet. Invite the first person above.')).toHaveLength(2)
  })

  it('renders no heading of its own (the People page has it)', async () => {
    renderPeople()

    await table()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })
})

describe('opening and closing', () => {
  it('opens a person\'s editor through the host, from the row\'s Edit', async () => {
    const { session, onOpenItem } = renderPeople()

    await session.click(within(await rowOf('Ada Lovelace')).getByRole('button', { name: 'Edit Ada Lovelace' }))

    expect(onOpenItem).toHaveBeenCalledWith('ada')
  })

  it('shows the editor sheet of the person the path names, and closes it through the host', async () => {
    const { session, onOpenItem } = renderPeople([ADA, VIC], 'ada')

    const sheet = await screen.findByRole('dialog', { name: 'Edit Ada Lovelace' })
    await session.click(within(sheet).getByRole('button', { name: 'Dismiss' }))

    expect(onOpenItem).toHaveBeenCalledWith(null)
  })

  it('opens nothing for a username the list does not hold', async () => {
    renderPeople([ADA], 'gone')

    await table()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks the host to open the invite dialog from the page\'s one primary', async () => {
    const { session, onOpenItem } = renderPeople()

    await session.click(await screen.findByRole('button', { name: 'Invite person' }))

    expect(onOpenItem).toHaveBeenCalledWith('invite')
  })
})

describe('inviting', () => {
  it('sends the invite with the role chosen, then closes through the host', async () => {
    const { session, onOpenItem } = renderPeople([], 'invite')
    const dialog = await screen.findByRole('dialog', { name: 'Invite person' })

    await session.type(within(dialog).getByPlaceholderText('user@example.com'), 'new@example.com')
    await session.click(within(dialog).getByRole('radio', { name: /admin/i }))
    await session.click(within(dialog).getByRole('button', { name: 'Send Invite' }))

    await waitFor(() => expect(client.api.createUser).toHaveBeenCalledWith({
      username: 'new@example.com', email: 'new@example.com', given_name: '', family_name: '', group: 'admins',
    }))
    expect(onOpenItem).toHaveBeenCalledWith(null)
  })

  it('closes the invite dialog on Cancel, through the host', async () => {
    const { session, onOpenItem } = renderPeople([], 'invite')

    await session.click(within(await screen.findByRole('dialog', { name: 'Invite person' })).getByRole('button', { name: 'Cancel' }))

    expect(onOpenItem).toHaveBeenCalledWith(null)
  })
})

describe('after a delete', () => {
  it('closes the sheet and says so on the page until the next move', async () => {
    const { session, onOpenItem } = renderPeople([ADA, VIC], 'vic')
    const sheet = await screen.findByRole('dialog', { name: 'Edit vic@example.com' })

    await session.click(within(sheet).getByRole('button', { name: 'Delete vic@example.com…' }))
    await session.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith(null))
    expect(screen.getAllByRole('status').some((line) => line.textContent === 'User deleted')).toBe(true)
  })
})

describe('loading and errors', () => {
  it('spins while the people load', () => {
    client.api.getUsers.mockReturnValue(new Promise(() => {}))
    mount(<UserAdmin openItem={null} onOpenItem={vi.fn()} />)

    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('says when the people could not be loaded', async () => {
    client.api.getUsers.mockRejectedValue(new Error('Access denied'))
    mount(<UserAdmin openItem={null} onOpenItem={vi.fn()} />)

    expect(await screen.findByText(/Failed to load users/)).toBeInTheDocument()
  })
})
