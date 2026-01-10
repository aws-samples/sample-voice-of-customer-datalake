/**
 * @fileoverview User Administration component for managing Cognito users.
 * 
 * Features:
 * - List all users with status and group
 * - Create new users (sends invite email)
 * - Change user role (admin/viewer)
 * - Reset password
 * - Enable/disable users
 * - Delete users
 * 
 * Only visible to users in the 'admins' group.
 * 
 * @module components/UserAdmin
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Users, UserPlus, Shield, Eye, Key, UserX, UserCheck, Trash2, 
  Loader2, CheckCircle2, AlertCircle, Mail
} from 'lucide-react'
import { api } from '../../api/client'
import type { CognitoUser } from '../../api/client'
import ConfirmModal from '../ConfirmModal'
import clsx from 'clsx'

type UserGroup = 'admins' | 'users'
type ActionType = 'delete' | 'disable' | 'enable' | 'reset'

interface ConfirmActionState {
  type: ActionType
  user: CognitoUser
}

// Helper functions for confirm modal
function getConfirmTitle(actionType: ActionType): string {
  if (actionType === 'delete') return 'Delete User'
  if (actionType === 'disable') return 'Disable User'
  if (actionType === 'enable') return 'Enable User'
  return 'Reset Password'
}

function getConfirmMessage(action: ConfirmActionState): string {
  const email = action.user.email
  if (action.type === 'delete') {
    return `Are you sure you want to delete ${email}? This cannot be undone.`
  }
  if (action.type === 'disable') {
    return `Disable ${email}? They will not be able to log in.`
  }
  if (action.type === 'enable') {
    return `Enable ${email}? They will be able to log in again.`
  }
  return `Send a password reset email to ${email}?`
}

function getConfirmLabel(actionType: ActionType): string {
  if (actionType === 'delete') return 'Delete'
  if (actionType === 'disable') return 'Disable'
  if (actionType === 'enable') return 'Enable'
  return 'Send Reset Email'
}

function getConfirmVariant(actionType: ActionType): 'danger' | 'info' {
  return actionType === 'delete' ? 'danger' : 'info'
}

// Status Badge Component
function StatusBadge({ user }: Readonly<{ user: CognitoUser }>) {
  if (!user.enabled) {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700">Disabled</span>
  }
  if (user.status === 'CONFIRMED') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">Active</span>
  }
  if (user.status === 'FORCE_CHANGE_PASSWORD') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700">Pending</span>
  }
  return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">{user.status}</span>
}

// Role Select Component
interface RoleSelectProps {
  readonly user: CognitoUser
  readonly isPending: boolean
  readonly onChange: (username: string, group: UserGroup) => void
  readonly size?: 'sm' | 'md'
}

function RoleSelect({ user, isPending, onChange, size = 'sm' }: RoleSelectProps) {
  const isAdmin = user.groups.includes('admins')
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    if (value === 'admins' || value === 'users') {
      onChange(user.username, value)
    }
  }

  return (
    <select
      value={isAdmin ? 'admins' : 'users'}
      onChange={handleChange}
      disabled={isPending}
      className={clsx(
        'text-sm border rounded',
        size === 'sm' ? 'px-2 py-1' : 'px-2 py-1.5',
        isAdmin 
          ? 'border-purple-300 bg-purple-50 text-purple-700'
          : 'border-gray-300 bg-white text-gray-700'
      )}
    >
      <option value="users">User</option>
      <option value="admins">Admin</option>
    </select>
  )
}

// User Action Buttons Component
interface UserActionButtonsProps {
  readonly user: CognitoUser
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly iconSize?: number
  readonly buttonPadding?: string
}

function UserActionButtons({ user, onAction, iconSize = 16, buttonPadding = 'p-1.5' }: UserActionButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onAction('reset', user)}
        className={clsx(buttonPadding, 'text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded')}
        title="Reset password"
      >
        <Key size={iconSize} />
      </button>
      {user.enabled ? (
        <button
          onClick={() => onAction('disable', user)}
          className={clsx(buttonPadding, 'text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded')}
          title="Disable user"
        >
          <UserX size={iconSize} />
        </button>
      ) : (
        <button
          onClick={() => onAction('enable', user)}
          className={clsx(buttonPadding, 'text-gray-500 hover:text-green-600 hover:bg-green-50 rounded')}
          title="Enable user"
        >
          <UserCheck size={iconSize} />
        </button>
      )}
      <button
        onClick={() => onAction('delete', user)}
        className={clsx(buttonPadding, 'text-gray-500 hover:text-red-600 hover:bg-red-50 rounded')}
        title="Delete user"
      >
        <Trash2 size={iconSize} />
      </button>
    </div>
  )
}

// Create User Modal Component
interface CreateUserModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onSuccess: () => void
}

function CreateUserModal({ isOpen, onClose, onSuccess }: CreateUserModalProps) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [group, setGroup] = useState<UserGroup>('users')
  const [error, setError] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.createUser({ username: email, email, name, group }),
    onSuccess: (data) => {
      if (data.success) {
        setEmail('')
        setName('')
        setGroup('users')
        setError('')
        onSuccess()
        onClose()
      } else {
        setError(data.message || 'Failed to create user')
      }
    },
    onError: (err: Error) => setError(err.message),
  })

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 sm:p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <UserPlus size={20} className="text-blue-600" />
          Add New User
        </h3>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Address *
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="input"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              A temporary password will be sent to this email
            </p>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name (optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              className="input"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="group"
                  value="users"
                  checked={group === 'users'}
                  onChange={() => setGroup('users')}
                  className="text-blue-600"
                />
                <Eye size={16} className="text-gray-500" />
                <span>User</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="group"
                  value="admins"
                  checked={group === 'admins'}
                  onChange={() => setGroup('admins')}
                  className="text-blue-600"
                />
                <Shield size={16} className="text-purple-500" />
                <span>Admin</span>
              </label>
            </div>
          </div>
          
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
              <AlertCircle size={16} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 mt-6">
          <button onClick={onClose} className="btn btn-secondary w-full sm:w-auto">
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!email || createMutation.isPending}
            className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            {createMutation.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Mail size={16} />
            )}
            Send Invite
          </button>
        </div>
      </div>
    </div>
  )
}

// Desktop Table Row Component
interface UserTableRowProps {
  readonly user: CognitoUser
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

function UserTableRow({ user, onRoleChange, onAction, isRoleChangePending }: UserTableRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3">
        <div>
          <p className="font-medium text-gray-900">{user.email}</p>
          {user.name && <p className="text-sm text-gray-500">{user.name}</p>}
        </div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge user={user} />
      </td>
      <td className="px-4 py-3">
        <RoleSelect user={user} isPending={isRoleChangePending} onChange={onRoleChange} />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end">
          <UserActionButtons user={user} onAction={onAction} />
        </div>
      </td>
    </tr>
  )
}

// Mobile Card Component
interface UserCardProps {
  readonly user: CognitoUser
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

function UserCard({ user, onRoleChange, onAction, isRoleChangePending }: UserCardProps) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 truncate">{user.email}</p>
          {user.name && <p className="text-sm text-gray-500">{user.name}</p>}
        </div>
        <StatusBadge user={user} />
      </div>
      
      <div className="flex items-center justify-between gap-2">
        <RoleSelect user={user} isPending={isRoleChangePending} onChange={onRoleChange} size="md" />
        <UserActionButtons user={user} onAction={onAction} iconSize={18} buttonPadding="p-2" />
      </div>
    </div>
  )
}

// Desktop Table Component
interface UsersTableProps {
  readonly users: CognitoUser[]
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

function UsersTable({ users, onRoleChange, onAction, isRoleChangePending }: UsersTableProps) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden hidden md:block">
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">User</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">Status</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">Role</th>
            <th className="text-right px-4 py-3 text-sm font-medium text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {users.map((user) => (
            <UserTableRow
              key={user.username}
              user={user}
              onRoleChange={onRoleChange}
              onAction={onAction}
              isRoleChangePending={isRoleChangePending}
            />
          ))}
        </tbody>
      </table>
      
      {users.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          No users found. Add your first user above.
        </div>
      )}
    </div>
  )
}

// Mobile Cards Component
interface UsersCardsProps {
  readonly users: CognitoUser[]
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

function UsersCards({ users, onRoleChange, onAction, isRoleChangePending }: UsersCardsProps) {
  if (users.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 border border-gray-200 rounded-lg">
        No users found. Add your first user above.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {users.map((user) => (
        <UserCard
          key={user.username}
          user={user}
          onRoleChange={onRoleChange}
          onAction={onAction}
          isRoleChangePending={isRoleChangePending}
        />
      ))}
    </div>
  )
}

// Main Component
export default function UserAdmin() {
  const queryClient = useQueryClient()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.getUsers(),
  })

  const showSuccess = (message: string) => {
    setActionSuccess(message)
    setTimeout(() => setActionSuccess(null), 3000)
  }

  const updateGroupMutation = useMutation({
    mutationFn: ({ username, group }: { username: string; group: UserGroup }) =>
      api.updateUserGroup(username, group),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess('User role updated')
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: (username: string) => api.resetUserPassword(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess('Password reset email sent')
      setConfirmAction(null)
    },
  })

  const enableMutation = useMutation({
    mutationFn: (username: string) => api.enableUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess('User enabled')
      setConfirmAction(null)
    },
  })

  const disableMutation = useMutation({
    mutationFn: (username: string) => api.disableUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess('User disabled')
      setConfirmAction(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (username: string) => api.deleteUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess('User deleted')
      setConfirmAction(null)
    },
  })

  const handleConfirmAction = () => {
    if (!confirmAction) return
    
    const { type, user } = confirmAction
    if (type === 'delete') {
      deleteMutation.mutate(user.username)
    } else if (type === 'disable') {
      disableMutation.mutate(user.username)
    } else if (type === 'enable') {
      enableMutation.mutate(user.username)
    } else {
      resetPasswordMutation.mutate(user.username)
    }
  }

  const handleRoleChange = (username: string, group: UserGroup) => {
    updateGroupMutation.mutate({ username, group })
  }

  const handleAction = (type: ActionType, user: CognitoUser) => {
    setConfirmAction({ type, user })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-red-600 bg-red-50 p-4 rounded-lg">
        <AlertCircle size={20} />
        <span>Failed to load users. Make sure you have admin access.</span>
      </div>
    )
  }

  const users = data?.users ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="text-blue-600" size={20} />
          <h3 className="font-semibold">User Management</h3>
          <span className="text-sm text-gray-500">({users.length} users)</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          <UserPlus size={16} />
          Add User
        </button>
      </div>

      {actionSuccess && (
        <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
          <CheckCircle2 size={16} />
          {actionSuccess}
        </div>
      )}

      <UsersTable
        users={users}
        onRoleChange={handleRoleChange}
        onAction={handleAction}
        isRoleChangePending={updateGroupMutation.isPending}
      />

      <div className="md:hidden">
        <UsersCards
          users={users}
          onRoleChange={handleRoleChange}
          onAction={handleAction}
          isRoleChangePending={updateGroupMutation.isPending}
        />
      </div>

      <CreateUserModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['users'] })}
      />

      {confirmAction && (
        <ConfirmModal
          isOpen={true}
          title={getConfirmTitle(confirmAction.type)}
          message={getConfirmMessage(confirmAction)}
          confirmLabel={getConfirmLabel(confirmAction.type)}
          variant={getConfirmVariant(confirmAction.type)}
          onConfirm={handleConfirmAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  )
}
