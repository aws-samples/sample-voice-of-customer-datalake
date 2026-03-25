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
import { useTranslation } from 'react-i18next'
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
function getConfirmTitle(actionType: ActionType, t: (key: string) => string): string {
  if (actionType === 'delete') return t('userAdmin.deleteUser')
  if (actionType === 'disable') return t('userAdmin.disableUser')
  if (actionType === 'enable') return t('userAdmin.enableUser')
  return t('userAdmin.resetPassword')
}

function getConfirmMessage(action: ConfirmActionState, t: (key: string, opts?: Record<string, string>) => string): string {
  const email = action.user.email
  if (action.type === 'delete') {
    return t('userAdmin.confirmDelete', { email })
  }
  if (action.type === 'disable') {
    return t('userAdmin.confirmDisable', { email })
  }
  if (action.type === 'enable') {
    return t('userAdmin.confirmEnable', { email })
  }
  return t('userAdmin.confirmReset', { email })
}

function getConfirmLabel(actionType: ActionType, t: (key: string) => string): string {
  if (actionType === 'delete') return t('userAdmin.delete')
  if (actionType === 'disable') return t('userAdmin.disable')
  if (actionType === 'enable') return t('userAdmin.enable')
  return t('userAdmin.sendResetEmail')
}

function getConfirmVariant(actionType: ActionType): 'danger' | 'info' {
  return actionType === 'delete' ? 'danger' : 'info'
}

// Status Badge Component
function StatusBadge({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  if (!user.enabled) {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700">{t('userAdmin.disabled')}</span>
  }
  if (user.status === 'CONFIRMED') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">{t('userAdmin.active')}</span>
  }
  if (user.status === 'FORCE_CHANGE_PASSWORD') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700">{t('userAdmin.pendingStatus')}</span>
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
  const { t } = useTranslation('components')
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
      <option value="users">{t('userAdmin.userRole')}</option>
      <option value="admins">{t('userAdmin.adminRole')}</option>
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
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onAction('reset', user)}
        className={clsx(buttonPadding, 'text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded')}
        title={t('userAdmin.resetPasswordTitle')}
      >
        <Key size={iconSize} />
      </button>
      {user.enabled ? (
        <button
          onClick={() => onAction('disable', user)}
          className={clsx(buttonPadding, 'text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded')}
          title={t('userAdmin.disableUserTitle')}
        >
          <UserX size={iconSize} />
        </button>
      ) : (
        <button
          onClick={() => onAction('enable', user)}
          className={clsx(buttonPadding, 'text-gray-500 hover:text-green-600 hover:bg-green-50 rounded')}
          title={t('userAdmin.enableUserTitle')}
        >
          <UserCheck size={iconSize} />
        </button>
      )}
      <button
        onClick={() => onAction('delete', user)}
        className={clsx(buttonPadding, 'text-gray-500 hover:text-red-600 hover:bg-red-50 rounded')}
        title={t('userAdmin.deleteUserTitle')}
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
  const { t } = useTranslation('components')
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
        setError(data.error || 'Failed to create user')
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
          {t('userAdmin.addNewUser')}
        </h3>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('userAdmin.emailLabel')}
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
              {t('userAdmin.emailHelp')}
            </p>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('userAdmin.nameLabel')}
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
              {t('userAdmin.roleLabel')}
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
                <span>{t('userAdmin.userRole')}</span>
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
                <span>{t('userAdmin.adminRole')}</span>
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
            {t('userAdmin.cancel')}
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
            {t('userAdmin.sendInvite')}
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
  const { t } = useTranslation('components')
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden hidden md:block">
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">{t('userAdmin.tableUser')}</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">{t('userAdmin.tableStatus')}</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">{t('userAdmin.tableRole')}</th>
            <th className="text-right px-4 py-3 text-sm font-medium text-gray-700">{t('userAdmin.tableActions')}</th>
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
          {t('userAdmin.noUsers')}
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
  const { t } = useTranslation('components')
  if (users.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 border border-gray-200 rounded-lg">
        {t('userAdmin.noUsers')}
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
  const { t } = useTranslation('components')
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
      showSuccess(t('userAdmin.roleUpdated'))
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: (username: string) => api.resetUserPassword(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.passwordResetSent'))
      setConfirmAction(null)
    },
  })

  const enableMutation = useMutation({
    mutationFn: (username: string) => api.enableUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userEnabled'))
      setConfirmAction(null)
    },
  })

  const disableMutation = useMutation({
    mutationFn: (username: string) => api.disableUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userDisabled'))
      setConfirmAction(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (username: string) => api.deleteUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userDeleted'))
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
        <span>{t('userAdmin.loadError')}</span>
      </div>
    )
  }

  const users = data?.users ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="text-blue-600" size={20} />
          <h3 className="font-semibold">{t('userAdmin.userManagement')}</h3>
          <span className="text-sm text-gray-500">{t('userAdmin.usersCount', { count: users.length })}</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          <UserPlus size={16} />
          {t('userAdmin.addUser')}
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
          title={getConfirmTitle(confirmAction.type, t)}
          message={getConfirmMessage(confirmAction, t)}
          confirmLabel={getConfirmLabel(confirmAction.type, t)}
          variant={getConfirmVariant(confirmAction.type)}
          onConfirm={handleConfirmAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  )
}
