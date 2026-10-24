/**
 * @fileoverview Sub-components for UserAdmin: table rows, cards, action buttons.
 * @module components/UserAdmin/UserAdminComponents
 */

import clsx from 'clsx'
import {
  Key, UserX, UserCheck, Trash2, Pencil, ShieldCheck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CognitoUser } from '../../api/types'

type UserGroup = 'admins' | 'users'
export type ActionType = 'delete' | 'disable' | 'enable' | 'reset' | 'edit' | 'access'

function getDisplayName(user: CognitoUser): string {
  const hasGivenName = user.given_name != null && user.given_name !== ''
  const hasFamilyName = user.family_name != null && user.family_name !== ''
  return hasGivenName || hasFamilyName
    ? `${user.given_name ?? ''} ${user.family_name ?? ''}`.trim()
    : user.name
}

// Status Badge Component
function StatusBadge({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  if (!user.enabled) {
    return <span className="badge badge-danger">{t('userAdmin.disabled')}</span>
  }
  if (user.status === 'CONFIRMED') {
    return <span className="badge badge-ok">{t('userAdmin.active')}</span>
  }
  if (user.status === 'FORCE_CHANGE_PASSWORD') {
    return <span className="badge badge-warn">{t('userAdmin.pendingStatus')}</span>
  }
  return <span className="badge badge-muted">{user.status}</span>
}

// Role Select Component
interface RoleSelectProps {
  readonly user: CognitoUser
  readonly isPending: boolean
  readonly onChange: (username: string, group: UserGroup) => void
  readonly size?: 'sm' | 'md'
}

function RoleSelect({
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
      aria-label={t('userAdmin.roleFor', { email: user.email || user.username })}
      title={t('userAdmin.roleFor', { email: user.email || user.username })}
      className={clsx(
        'select w-auto',
        size === 'sm' ? 'select-sm' : 'py-1.5',
        isAdmin && 'border-aim bg-aim-subtle text-aim',
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

function UserActionButtons({
  user, onAction, iconSize = 16, buttonPadding = 'p-1.5',
}: UserActionButtonsProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onAction('edit', user)}
        className={clsx(buttonPadding, 'text-muted hover:text-accent-text hover:bg-accent-subtle rounded-sm')}
        title={t('userAdmin.editUserTitle')}
      >
        <Pencil size={iconSize} />
      </button>
      <button
        onClick={() => onAction('access', user)}
        className={clsx(buttonPadding, 'text-muted hover:text-accent-text hover:bg-accent-subtle rounded-sm')}
        title={t('userAdmin.categoryAccess.title')}
        aria-label={t('userAdmin.categoryAccess.title')}
      >
        <ShieldCheck size={iconSize} />
      </button>
      <button
        onClick={() => onAction('reset', user)}
        className={clsx(buttonPadding, 'text-muted hover:text-accent-text hover:bg-accent-subtle rounded-sm')}
        title={t('userAdmin.resetPasswordTitle')}
      >
        <Key size={iconSize} />
      </button>
      {user.enabled ? (
        <button
          onClick={() => onAction('disable', user)}
          className={clsx(buttonPadding, 'text-muted hover:text-warn hover:bg-warn-subtle rounded-sm')}
          title={t('userAdmin.disableUserTitle')}
        >
          <UserX size={iconSize} />
        </button>
      ) : (
        <button
          onClick={() => onAction('enable', user)}
          className={clsx(buttonPadding, 'text-muted hover:text-ok hover:bg-ok-subtle rounded-sm')}
          title={t('userAdmin.enableUserTitle')}
        >
          <UserCheck size={iconSize} />
        </button>
      )}
      <button
        onClick={() => onAction('delete', user)}
        className={clsx(buttonPadding, 'text-muted hover:text-danger hover:bg-danger-subtle rounded-sm')}
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
    <tr className="hover:bg-bg-hover">
      <td className="px-4 py-3">
        <div>
          <p className="font-medium text-text-strong">{user.email}</p>
          {user.name === '' ? null : <p className="text-sm text-muted">{getDisplayName(user)}</p>}
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
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-text-strong truncate" title={user.email}>{user.email}</p>
          {user.name === '' ? null : <p className="text-sm text-muted">{getDisplayName(user)}</p>}
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

/** Props of both user-list layouts: the desktop table and the mobile cards. */
interface UsersListProps {
  readonly users: CognitoUser[]
  readonly onRoleChange: (username: string, group: UserGroup) => void
  readonly onAction: (type: ActionType, user: CognitoUser) => void
  readonly isRoleChangePending: boolean
}

// Desktop Table Component

export function UsersTable({
  users, onRoleChange, onAction, isRoleChangePending,
}: UsersListProps) {
  const { t } = useTranslation('components')
  return (
    <div className="border border-border rounded-lg overflow-hidden hidden md:block">
      <table className="w-full">
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-medium text-text">{t('userAdmin.tableUser')}</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-text">{t('userAdmin.tableStatus')}</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-text">{t('userAdmin.tableRole')}</th>
            <th className="text-right px-4 py-3 text-sm font-medium text-text">{t('userAdmin.tableActions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
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
        <div className="text-center py-8 text-muted">
          {t('userAdmin.noUsers')}
        </div>
      )}
    </div>
  )
}

// Mobile Cards Component

export function UsersCards({
  users, onRoleChange, onAction, isRoleChangePending,
}: UsersListProps) {
  const { t } = useTranslation('components')
  if (users.length === 0) {
    return (
      <div className="text-center py-8 text-muted border border-border rounded-lg">
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
