/**
 * @fileoverview Tests for UserAdmin component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock API before importing component
const mockGetUsers = vi.fn()
const mockCreateUser = vi.fn()
const mockUpdateUserGroup = vi.fn()
const mockResetUserPassword = vi.fn()
const mockEnableUser = vi.fn()
const mockDisableUser = vi.fn()
const mockDeleteUser = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getUsers: () => mockGetUsers(),
    createUser: (data: unknown) => mockCreateUser(data),
    updateUserGroup: (username: string, group: string) => mockUpdateUserGroup(username, group),
    resetUserPassword: (username: string) => mockResetUserPassword(username),
    enableUser: (username: string) => mockEnableUser(username),
    disableUser: (username: string) => mockDisableUser(username),
    deleteUser: (username: string) => mockDeleteUser(username),
  },
}))

import UserAdmin from './UserAdmin'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('UserAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUsers.mockResolvedValue({ users: [] })
    mockCreateUser.mockResolvedValue({ success: true })
    mockUpdateUserGroup.mockResolvedValue({ success: true })
    mockResetUserPassword.mockResolvedValue({ success: true })
    mockEnableUser.mockResolvedValue({ success: true })
    mockDisableUser.mockResolvedValue({ success: true })
    mockDeleteUser.mockResolvedValue({ success: true })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching users', () => {
      mockGetUsers.mockReturnValue(new Promise(() => {}))
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockGetUsers.mockRejectedValue(new Error('Access denied'))
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/failed to load users/i)).toBeInTheDocument()
      })
    })
  })

  describe('header', () => {
    it('displays user management title', async () => {
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('User Management')).toBeInTheDocument()
      })
    })

    it('displays user count', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'user1@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
          { username: 'user2', email: 'user2@example.com', status: 'CONFIRMED', enabled: true, groups: ['admins'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('(2 users)')).toBeInTheDocument()
      })
    })

    it('displays Add User button', async () => {
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
    })
  })

  describe('empty state', () => {
    it('shows empty message when no users exist', async () => {
      mockGetUsers.mockResolvedValue({ users: [] })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Both desktop and mobile show empty state, just check one exists
        const emptyMessages = screen.getAllByText(/no users found/i)
        expect(emptyMessages.length).toBeGreaterThan(0)
      })
    })
  })

  describe('users list', () => {
    it('displays user email', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Both desktop and mobile render the email, just check one exists
        const emails = screen.getAllByText('test@example.com')
        expect(emails.length).toBeGreaterThan(0)
      })
    })

    it('displays user name when available', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', name: 'John Doe', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Both desktop and mobile render the name
        const names = screen.getAllByText('John Doe')
        expect(names.length).toBeGreaterThan(0)
      })
    })
  })

  describe('status badges', () => {
    it('shows Active badge for confirmed enabled users', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Both desktop and mobile render status badges
        const badges = screen.getAllByText('Active')
        expect(badges.length).toBeGreaterThan(0)
      })
    })

    it('shows Disabled badge for disabled users', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: false, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        const badges = screen.getAllByText('Disabled')
        expect(badges.length).toBeGreaterThan(0)
      })
    })

    it('shows Pending badge for users requiring password change', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'FORCE_CHANGE_PASSWORD', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        const badges = screen.getAllByText('Pending')
        expect(badges.length).toBeGreaterThan(0)
      })
    })
  })

  describe('role selector', () => {
    it('displays role dropdown with current role selected', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['admins'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Both desktop and mobile have dropdowns
        const selects = screen.getAllByRole('combobox')
        expect(selects.length).toBeGreaterThan(0)
        expect(selects[0]).toHaveValue('admins')
      })
    })

    it('calls updateUserGroup when role is changed', async () => {
      const user = userEvent.setup()
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0)
      })
      
      // Use the first dropdown (desktop)
      await user.selectOptions(screen.getAllByRole('combobox')[0], 'admins')
      
      await waitFor(() => {
        expect(mockUpdateUserGroup).toHaveBeenCalledWith('user1', 'admins')
      })
    })
  })

  describe('create user modal', () => {
    it('opens modal when Add User is clicked', async () => {
      const user = userEvent.setup()
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /add user/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Add New User')).toBeInTheDocument()
      })
    })

    it('displays email input field', async () => {
      const user = userEvent.setup()
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /add user/i }))
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument()
      })
    })

    it('displays role selection', async () => {
      const user = userEvent.setup()
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /add user/i }))
      
      await waitFor(() => {
        // Check for role radio buttons by their labels
        expect(screen.getByRole('radio', { name: /user/i })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: /admin/i })).toBeInTheDocument()
      })
    })

    it('calls createUser API when form is submitted', async () => {
      const user = userEvent.setup()
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /add user/i }))
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument()
      })
      
      await user.type(screen.getByPlaceholderText('user@example.com'), 'new@example.com')
      await user.type(screen.getByPlaceholderText('John Doe'), 'New User')
      await user.click(screen.getByRole('button', { name: /send invite/i }))
      
      await waitFor(() => {
        expect(mockCreateUser).toHaveBeenCalledWith({
          email: 'new@example.com',
          name: 'New User',
          group: 'viewers',
        })
      })
    })

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /add user/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Add New User')).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /cancel/i }))
      
      await waitFor(() => {
        expect(screen.queryByText('Add New User')).not.toBeInTheDocument()
      })
    })
  })

  describe('user actions', () => {
    it('shows reset password confirmation when button is clicked', async () => {
      const user = userEvent.setup()
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByTitle('Reset password').length).toBeGreaterThan(0)
      })
      
      // Click the first reset button (desktop)
      await user.click(screen.getAllByTitle('Reset password')[0])
      
      await waitFor(() => {
        expect(screen.getByText('Reset Password')).toBeInTheDocument()
        expect(screen.getByText(/send a password reset email/i)).toBeInTheDocument()
      })
    })

    it('shows disable confirmation for enabled users', async () => {
      const user = userEvent.setup()
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByTitle('Disable user').length).toBeGreaterThan(0)
      })
      
      await user.click(screen.getAllByTitle('Disable user')[0])
      
      await waitFor(() => {
        expect(screen.getByText('Disable User')).toBeInTheDocument()
      })
    })

    it('shows enable button for disabled users', async () => {
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: false, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByTitle('Enable user').length).toBeGreaterThan(0)
      })
    })

    it('shows delete confirmation when delete is clicked', async () => {
      const user = userEvent.setup()
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByTitle('Delete user').length).toBeGreaterThan(0)
      })
      
      await user.click(screen.getAllByTitle('Delete user')[0])
      
      await waitFor(() => {
        expect(screen.getByText('Delete User')).toBeInTheDocument()
        expect(screen.getByText(/are you sure you want to delete/i)).toBeInTheDocument()
      })
    })
  })

  describe('success messages', () => {
    it('shows success message after role update', async () => {
      const user = userEvent.setup()
      mockGetUsers.mockResolvedValue({
        users: [
          { username: 'user1', email: 'test@example.com', status: 'CONFIRMED', enabled: true, groups: ['viewers'] },
        ],
      })
      
      render(<UserAdmin />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0)
      })
      
      await user.selectOptions(screen.getAllByRole('combobox')[0], 'admins')
      
      await waitFor(() => {
        expect(screen.getByText('User role updated')).toBeInTheDocument()
      })
    })
  })
})
