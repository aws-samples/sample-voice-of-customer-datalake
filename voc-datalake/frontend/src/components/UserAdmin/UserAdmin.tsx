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

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Users, UserPlus,
  Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import ConfirmModal from '../ConfirmModal'
import CreateUserModal from './CreateUserModal'
import EditUserModal from './EditUserModal'
import {
  UsersTable, UsersCards,
} from './UserAdminComponents'
import type { ActionType } from './UserAdminComponents'
import type { CognitoUser } from '../../api/types'

type UserGroup = 'admins' | 'users'

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
  if (action.type === 'delete') return t('userAdmin.confirmDelete', { email })
  if (action.type === 'disable') return t('userAdmin.confirmDisable', { email })
  if (action.type === 'enable') return t('userAdmin.confirmEnable', { email })
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

export default function UserAdmin() {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingUser, setEditingUser] = useState<CognitoUser | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const {
    data, isLoading, error,
  } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.getUsers(),
  })

  const showSuccess = (message: string) => {
    setActionSuccess(message)
    setTimeout(() => setActionSuccess(null), 3000)
  }

  const updateGroupMutation = useMutation({
    mutationFn: ({
      username, group,
    }: {
      username: string;
      group: UserGroup
    }) =>
      api.updateUserGroup(username, group),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.roleUpdated'))
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: (username: string) => api.resetUserPassword(username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.passwordResetSent'))
      setConfirmAction(null)
    },
  })

  const enableMutation = useMutation({
    mutationFn: (username: string) => api.enableUser(username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userEnabled'))
      setConfirmAction(null)
    },
  })

  const disableMutation = useMutation({
    mutationFn: (username: string) => api.disableUser(username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userDisabled'))
      setConfirmAction(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (username: string) => api.deleteUser(username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      showSuccess(t('userAdmin.userDeleted'))
      setConfirmAction(null)
    },
  })

  const handleConfirmAction = () => {
    if (!confirmAction) return

    const {
      type, user,
    } = confirmAction
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
    updateGroupMutation.mutate({
      username,
      group,
    })
  }

  const handleAction = (type: ActionType, user: CognitoUser) => {
    if (type === 'edit') {
      setEditingUser(user)
      return
    }
    setConfirmAction({
      type,
      user,
    })
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

      {actionSuccess == null || actionSuccess === '' ? null : <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
        <CheckCircle2 size={16} />
        {actionSuccess}
      </div>}

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
        onSuccess={() => void queryClient.invalidateQueries({ queryKey: ['users'] })}
      />

      <EditUserModal
        isOpen={editingUser !== null}
        user={editingUser}
        onClose={() => setEditingUser(null)}
        onSuccess={() => void queryClient.invalidateQueries({ queryKey: ['users'] })}
      />

      {confirmAction ? <ConfirmModal
        isOpen
        title={getConfirmTitle(confirmAction.type, t)}
        message={getConfirmMessage(confirmAction, t)}
        confirmLabel={getConfirmLabel(confirmAction.type, t)}
        variant={getConfirmVariant(confirmAction.type)}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      /> : null}
    </div>
  )
}
