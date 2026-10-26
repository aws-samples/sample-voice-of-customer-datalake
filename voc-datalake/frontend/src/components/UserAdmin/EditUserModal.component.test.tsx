/**
 * @fileoverview Component tests for EditUserModal — open/close, form validation,
 * submit mutation, and error display.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { cognitoUser } from './userAdmin-fixtures'

const mockUpdateUser = vi.fn<(username: string, data: unknown) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    updateUser: (username: string, data: unknown) => mockUpdateUser(username, data),
  },
}))

import EditUserModal from './EditUserModal'

const testUser = cognitoUser({ username: 'user-123', name: 'Test User', given_name: 'Test', family_name: 'User' })

type ModalProps = React.ComponentProps<typeof EditUserModal>

/** Mount the modal open on `testUser`, with fresh close/success spies unless given. */
function renderModal(overrides: Partial<ModalProps> = {}) {
  const props: ModalProps = {
    isOpen: true,
    user: testUser,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  }
  const user = userEvent.setup()
  renderWithQueryClient(<EditUserModal {...props} />)
  return { user, onClose: props.onClose, onSuccess: props.onSuccess }
}

/** Replace the first name with `value` and press Save. */
async function saveFirstName(user: UserEvent, value: string): Promise<void> {
  await user.clear(screen.getByDisplayValue('Test'))
  await user.type(screen.getByDisplayValue(''), value)
  await user.click(screen.getByRole('button', { name: /save/i }))
}

describe('EditUserModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateUser.mockResolvedValue({ success: true, message: 'User updated' })
  })

  it('renders nothing when isOpen is false', () => {
    renderModal({ isOpen: false })

    expect(screen.queryByText('test@example.com')).not.toBeInTheDocument()
  })

  it('renders nothing when user is null', () => {
    renderModal({ user: null })

    expect(screen.queryByText('test@example.com')).not.toBeInTheDocument()
  })

  it('displays user email and pre-filled name fields when open', () => {
    renderModal()

    expect(screen.getByText('test@example.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Test')).toBeInTheDocument()
    expect(screen.getByDisplayValue('User')).toBeInTheDocument()
  })

  it('calls onClose when Cancel is clicked', async () => {
    const { user, onClose } = renderModal()

    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables Save button when no changes are made', () => {
    renderModal()

    const saveButton = screen.getByRole('button', { name: /save/i })
    expect(saveButton).toBeDisabled()
  })

  it('enables Save button when name is changed', async () => {
    const { user } = renderModal()

    await user.clear(screen.getByDisplayValue('Test'))
    await user.type(screen.getByDisplayValue(''), 'Updated')

    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
  })

  it('disables Save button when both name fields are cleared', async () => {
    const { user } = renderModal()

    await user.clear(screen.getByDisplayValue('Test'))
    await user.clear(screen.getByDisplayValue('User'))

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('calls updateUser API with correct args on submit', async () => {
    const { user, onClose, onSuccess } = renderModal()

    await saveFirstName(user, 'NewFirst')

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
        given_name: 'NewFirst',
        family_name: 'User',
      })
    })

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith()
      expect(onClose).toHaveBeenCalledExactlyOnceWith()
    })
  })

  it('displays error when API returns success false', async () => {
    mockUpdateUser.mockResolvedValue({ success: false, message: 'Name too long' })
    const { user } = renderModal()

    await saveFirstName(user, 'X')

    await waitFor(() => {
      expect(screen.getByText('Name too long')).toBeInTheDocument()
    })
  })

  it('displays error when API call throws', async () => {
    mockUpdateUser.mockRejectedValue(new Error('Network error'))
    const { user } = renderModal()

    await saveFirstName(user, 'X')

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument()
    })
  })
})
