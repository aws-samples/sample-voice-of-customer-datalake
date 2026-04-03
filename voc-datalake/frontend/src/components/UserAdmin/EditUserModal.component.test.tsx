/**
 * @fileoverview Component tests for EditUserModal — open/close, form validation,
 * submit mutation, and error display.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockUpdateUser = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    updateUser: (username: string, data: unknown) => mockUpdateUser(username, data),
  },
}))

import EditUserModal from './EditUserModal'
import type { CognitoUser } from '../../api/types'

const testUser: CognitoUser = {
  username: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  given_name: 'Test',
  family_name: 'User',
  status: 'CONFIRMED',
  enabled: true,
  groups: ['users'],
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const defaultProps = {
  isOpen: true,
  user: testUser,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
}

describe('EditUserModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateUser.mockResolvedValue({ success: true, message: 'User updated' })
  })

  it('renders nothing when isOpen is false', () => {
    render(
      <EditUserModal {...defaultProps} isOpen={false} />,
      { wrapper: createWrapper() },
    )

    expect(screen.queryByText('test@example.com')).not.toBeInTheDocument()
  })

  it('renders nothing when user is null', () => {
    render(
      <EditUserModal {...defaultProps} user={null} />,
      { wrapper: createWrapper() },
    )

    expect(screen.queryByText('test@example.com')).not.toBeInTheDocument()
  })

  it('displays user email and pre-filled name fields when open', () => {
    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    expect(screen.getByText('test@example.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Test')).toBeInTheDocument()
    expect(screen.getByDisplayValue('User')).toBeInTheDocument()
  })

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <EditUserModal {...defaultProps} onClose={onClose} />,
      { wrapper: createWrapper() },
    )

    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('disables Save button when no changes are made', () => {
    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    const saveButton = screen.getByRole('button', { name: /save/i })
    expect(saveButton).toBeDisabled()
  })

  it('enables Save button when name is changed', async () => {
    const user = userEvent.setup()

    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    await user.clear(screen.getByDisplayValue('Test'))
    await user.type(screen.getByDisplayValue(''), 'Updated')

    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
  })

  it('disables Save button when both name fields are cleared', async () => {
    const user = userEvent.setup()

    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    await user.clear(screen.getByDisplayValue('Test'))
    await user.clear(screen.getByDisplayValue('User'))

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('calls updateUser API with correct args on submit', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSuccess = vi.fn()

    render(
      <EditUserModal {...defaultProps} onClose={onClose} onSuccess={onSuccess} />,
      { wrapper: createWrapper() },
    )

    await user.clear(screen.getByDisplayValue('Test'))
    await user.type(screen.getByDisplayValue(''), 'NewFirst')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
        given_name: 'NewFirst',
        family_name: 'User',
      })
    })

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('displays error when API returns success false', async () => {
    mockUpdateUser.mockResolvedValue({ success: false, message: 'Name too long' })
    const user = userEvent.setup()

    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    await user.clear(screen.getByDisplayValue('Test'))
    await user.type(screen.getByDisplayValue(''), 'X')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Name too long')).toBeInTheDocument()
    })
  })

  it('displays error when API call throws', async () => {
    mockUpdateUser.mockRejectedValue(new Error('Network error'))
    const user = userEvent.setup()

    render(
      <EditUserModal {...defaultProps} />,
      { wrapper: createWrapper() },
    )

    await user.clear(screen.getByDisplayValue('Test'))
    await user.type(screen.getByDisplayValue(''), 'X')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument()
    })
  })
})
