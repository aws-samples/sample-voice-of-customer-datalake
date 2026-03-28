/**
 * @fileoverview Sub-components for UserAdmin: table rows, cards, action buttons.
 * @module components/UserAdmin/UserAdminComponents
 */

import clsx from 'clsx'
import {
  Key, UserX, UserCheck, Trash2, Pencil,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CognitoUser } from '../../api/types'

type UserGroup = 'admins' | 'users'
export type ActionType = 'delete' | 'disable' | 'enable' | 'reset' | 'edit'

// Status Badge Component
export function StatusBadge({ user }: Readonly<{ user: CognitoUser }>) {
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

export function RoleSelect({
  user, isPending, onChange, size = 'sm',
}: RoleSelectProps) {
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
          : 'border-gray-300 bg-white text-gray-700',
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

export function UserActionButtons({
  user, onAction, iconSize = 16, buttonPadding = 'p-1.5',
}: UserActionButtonsProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onAction('edit', user)}
        className={clsx(buttonPadding, 'text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded')}
        title={t('userAdmin.editUserTitle')}
      >
        <Pencil size={iconSize} />
      </button>
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

// Desktop Table Row Component
interface UserTableRowProps {
  readonly user: CognitoUser
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

function UserTableRow({
  user, onRoleChange, onAction, isRoleChangePending,
}: UserTableRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3">
        <div>
          <p className="font-medium text-gray-900">{user.email}</p>
          {user.name === '' ? null : <p className="text-sm text-gray-500">{user.given_name || user.family_name ? `${user.given_name} ${user.family_name}`.trim() : user.name}</p>}
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

function UserCard({
  user, onRoleChange, onAction, isRoleChangePending,
}: UserCardProps) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 truncate">{user.email}</p>
          {user.name === '' ? null : <p className="text-sm text-gray-500">{user.given_name || user.family_name ? `${user.given_name} ${user.family_name}`.trim() : user.name}</p>}
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

export function UsersTable({
  users, onRoleChange, onAction, isRoleChangePending,
}: UsersTableProps) {
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

export function UsersCards({
  users, onRoleChange, onAction, isRoleChangePending,
}: UsersCardsProps) {
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
