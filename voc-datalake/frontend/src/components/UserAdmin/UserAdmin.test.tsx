/**
 * @fileoverview Tests for UserAdmin component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import type { CognitoUser } from '../../api/types'
import { required } from '../component-spec-fixtures'
import { cognitoUser } from './userAdmin-fixtures'

// Mock API before importing component
const mockGetUsers = vi.fn<() => Promise<unknown>>()
const mockCreateUser = vi.fn<(data: unknown) => Promise<unknown>>()
const mockUpdateUserGroup = vi.fn<(username: string, group: string) => Promise<unknown>>()
const mockResetUserPassword = vi.fn<(username: string) => Promise<unknown>>()
const mockEnableUser = vi.fn<(username: string) => Promise<unknown>>()
const mockDisableUser = vi.fn<(username: string) => Promise<unknown>>()
const mockDeleteUser = vi.fn<(username: string) => Promise<unknown>>()
const mockUpdateUser = vi.fn<(username: string, data: unknown) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    getUsers: () => mockGetUsers(),
    createUser: (data: unknown) => mockCreateUser(data),
    updateUserGroup: (username: string, group: string) => mockUpdateUserGroup(username, group),
    updateUser: (username: string, data: unknown) => mockUpdateUser(username, data),
    resetUserPassword: (username: string) => mockResetUserPassword(username),
    enableUser: (username: string) => mockEnableUser(username),
    disableUser: (username: string) => mockDisableUser(username),
    deleteUser: (username: string) => mockDeleteUser(username),
  },
}))

import UserAdmin from './UserAdmin'

/** Mount the admin panel; `users` (when given) is what `GET /users` returns. */
function renderAdmin(users?: CognitoUser[]): UserEvent {
  if (users !== undefined) mockGetUsers.mockResolvedValue({ users })
  const user = userEvent.setup()
  renderWithQueryClient(<UserAdmin />)
  return user
}

/** Mount with one user and wait for that row's controls. */
async function renderOneUser(overrides: Partial<CognitoUser> = {}): Promise<UserEvent> {
  const user = renderAdmin([cognitoUser(overrides)])
  await screen.findAllByRole('combobox')
  return user
}

/**
 * The first element titled `title` — the desktop row's, since desktop and mobile
 * layouts both render every row — once one is on screen.
 */
async function firstByTitle(title: string): Promise<HTMLElement> {
  const [first] = await screen.findAllByTitle(title)
  return required(first, `an element titled "${title}"`)
}

/** The desktop row's role dropdown. */
function firstRoleSelect(): HTMLElement {
  const [first] = screen.getAllByRole('combobox')
  return required(first, 'a role dropdown')
}

/** Mount with no users and open the Add User modal. */
async function openCreateModal(): Promise<UserEvent> {
  const user = renderAdmin()
  await user.click(await screen.findByRole('button', { name: /add user/i }))
  await screen.findByText('Add New User')
  return user
}

describe('UserAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUsers.mockResolvedValue({ users: [] })
    mockCreateUser.mockResolvedValue({ success: true })
    mockUpdateUserGroup.mockResolvedValue({ success: true })
    mockUpdateUser.mockResolvedValue({ success: true, message: 'User updated' })
    mockResetUserPassword.mockResolvedValue({ success: true })
    mockEnableUser.mockResolvedValue({ success: true })
    mockDisableUser.mockResolvedValue({ success: true })
    mockDeleteUser.mockResolvedValue({ success: true })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching users', () => {
      mockGetUsers.mockReturnValue(new Promise(() => {}))

      renderAdmin()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockGetUsers.mockRejectedValue(new Error('Access denied'))

      renderAdmin()

      expect(await screen.findByText(/failed to load users/i)).toBeInTheDocument()
    })
  })

  describe('header', () => {
    it('renders no heading of its own — the Settings "User Administration" card supplies the section title', async () => {
      renderAdmin()

      expect(await screen.findByRole('button', { name: /add user/i })).toBeInTheDocument()
      expect(screen.queryByRole('heading')).not.toBeInTheDocument()
      expect(screen.queryByText('User Management')).not.toBeInTheDocument()
    })

    it('displays user count', async () => {
      renderAdmin([
        cognitoUser({ username: 'user1', email: 'user1@example.com' }),
        cognitoUser({ username: 'user2', email: 'user2@example.com', groups: ['admins'] }),
      ])

      expect(await screen.findByText('(2 users)')).toBeInTheDocument()
    })

    it('displays Add User button', async () => {
      renderAdmin()

      expect(await screen.findByRole('button', { name: /add user/i })).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty message when no users exist', async () => {
      renderAdmin([])

      // Both desktop and mobile show the empty state.
      expect((await screen.findAllByText(/no users found/i)).length).toBeGreaterThan(0)
    })
  })

  describe('users list', () => {
    it('displays user email', async () => {
      renderAdmin([cognitoUser()])

      // Both desktop and mobile render the email.
      expect((await screen.findAllByText('test@example.com')).length).toBeGreaterThan(0)
    })

    it('displays user name when available', async () => {
      renderAdmin([cognitoUser({ name: 'John Doe', given_name: 'John', family_name: 'Doe' })])

      expect((await screen.findAllByText('John Doe')).length).toBeGreaterThan(0)
    })
  })

  describe('status badges', () => {
    it.each([
      ['Active', 'confirmed enabled users', {}],
      ['Disabled', 'disabled users', { enabled: false }],
      ['Pending', 'users requiring password change', { status: 'FORCE_CHANGE_PASSWORD' }],
    ] as const)('shows %s badge for %s', async (badge, _who, overrides) => {
      renderAdmin([cognitoUser(overrides)])

      // Both desktop and mobile render status badges.
      expect((await screen.findAllByText(badge)).length).toBeGreaterThan(0)
    })
  })

  describe('role selector', () => {
    it('displays role dropdown with current role selected', async () => {
      await renderOneUser({ groups: ['admins'] })

      expect(firstRoleSelect()).toHaveValue('admins')
    })

    it('calls updateUserGroup when role is changed', async () => {
      const user = await renderOneUser()

      await user.selectOptions(firstRoleSelect(), 'admins')

      await waitFor(() => {
        expect(mockUpdateUserGroup).toHaveBeenCalledWith('user1', 'admins')
      })
    })
  })

  describe('create user modal', () => {
    it('opens modal when Add User is clicked', async () => {
      await openCreateModal()

      expect(screen.getByText('Add New User')).toBeInTheDocument()
    })

    it('displays email input field', async () => {
      await openCreateModal()

      expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument()
    })

    it('displays role selection', async () => {
      await openCreateModal()

      expect(screen.getByRole('radio', { name: /user/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /admin/i })).toBeInTheDocument()
    })

    it('calls createUser API when form is submitted', async () => {
      const user = await openCreateModal()

      await user.type(screen.getByPlaceholderText('user@example.com'), 'new@example.com')
      await user.type(screen.getByPlaceholderText('Jane'), 'New')
      await user.type(screen.getByPlaceholderText('Doe'), 'User')
      await user.click(screen.getByRole('button', { name: /send invite/i }))

      await waitFor(() => {
        expect(mockCreateUser).toHaveBeenCalledWith({
          username: 'new@example.com',
          email: 'new@example.com',
          given_name: 'New',
          family_name: 'User',
          group: 'users',
        })
      })
    })

    it('closes modal when Cancel is clicked', async () => {
      const user = await openCreateModal()

      await user.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => {
        expect(screen.queryByText('Add New User')).not.toBeInTheDocument()
      })
    })
  })

  describe('user actions', () => {
    it.each([
      ['reset password', 'Reset password', 'Reset Password', /send a password reset email/i],
      ['disable', 'Disable user', 'Disable User', /they will not be able to log in/i],
      ['delete', 'Delete user', 'Delete User', /are you sure you want to delete/i],
    ] as const)('shows the %s confirmation when its button is clicked', async (_action, title, heading, body) => {
      const user = renderAdmin([cognitoUser()])

      await user.click(await firstByTitle(title))

      expect(await screen.findByText(heading)).toBeInTheDocument()
      expect(screen.getByText(body)).toBeInTheDocument()
    })

    it('shows enable button for disabled users', async () => {
      renderAdmin([cognitoUser({ enabled: false })])

      expect(await firstByTitle('Enable user')).toBeInTheDocument()
    })
  })

  describe('success messages', () => {
    it('shows success message after role update', async () => {
      const user = await renderOneUser()

      await user.selectOptions(firstRoleSelect(), 'admins')

      expect(await screen.findByText('User role updated')).toBeInTheDocument()
    })
  })
})
