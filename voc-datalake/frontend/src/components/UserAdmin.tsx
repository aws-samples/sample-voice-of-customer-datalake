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
import { api } from '../api/client'
import type { CognitoUser } from '../api/client'
import ConfirmModal from './ConfirmModal'
import clsx from 'clsx'

interface CreateUserModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

function CreateUserModal({ isOpen, onClose, onSuccess }: CreateUserModalProps) {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [group, setGroup] = useState<'admins' | 'viewers'>('viewers')
  const [error, setError] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.createUser({ username, email, name, group }),
    onSuccess: (data) => {
      if (data.success) {
        setUsername('')
        setEmail('')
        setName('')
        setGroup('viewers')
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
              Username *
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              placeholder="johndoe"
              className="input"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Lowercase letters, numbers, hyphens and underscores only
            </p>
          </div>
          
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
                  value="viewers"
                  checked={group === 'viewers'}
                  onChange={() => setGroup('viewers')}
                  className="text-blue-600"
                />
                <Eye size={16} className="text-gray-500" />
                <span>Viewer</span>
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
            disabled={!username || !email || createMutation.isPending}
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

export default function UserAdmin() {
  const queryClient = useQueryClient()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{
    type: 'delete' | 'disable' | 'enable' | 'reset'
    user: CognitoUser
  } | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.getUsers(),
  })

  const updateGroupMutation = useMutation({
    mutationFn: ({ username, group }: { username: string; group: 'admins' | 'viewers' }) =>
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

  const showSuccess = (message: string) => {
    setActionSuccess(message)
    setTimeout(() => setActionSuccess(null), 3000)
  }

  const handleConfirmAction = () => {
    if (!confirmAction) return
    
    switch (confirmAction.type) {
      case 'delete':
        deleteMutation.mutate(confirmAction.user.username)
        break
      case 'disable':
        disableMutation.mutate(confirmAction.user.username)
        break
      case 'enable':
        enableMutation.mutate(confirmAction.user.username)
        break
      case 'reset':
        resetPasswordMutation.mutate(confirmAction.user.username)
        break
    }
  }

  const getStatusBadge = (user: CognitoUser) => {
    if (!user.enabled) {
      return <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700">Disabled</span>
    }
    switch (user.status) {
      case 'CONFIRMED':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">Active</span>
      case 'FORCE_CHANGE_PASSWORD':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700">Pending</span>
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">{user.status}</span>
    }
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

  const users = data?.users || []

  return (
    <div className="space-y-4">
      {/* Header */}
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

      {/* Success message */}
      {actionSuccess && (
        <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
          <CheckCircle2 size={16} />
          {actionSuccess}
        </div>
      )}

      {/* Users table - desktop */}
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
              <tr key={user.username} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div>
                    <p className="font-medium text-gray-900">{user.email}</p>
                    {user.name && <p className="text-sm text-gray-500">{user.name}</p>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {getStatusBadge(user)}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={user.groups.includes('admins') ? 'admins' : 'viewers'}
                    onChange={(e) => updateGroupMutation.mutate({
                      username: user.username,
                      group: e.target.value as 'admins' | 'viewers'
                    })}
                    disabled={updateGroupMutation.isPending}
                    className={clsx(
                      'text-sm border rounded px-2 py-1',
                      user.groups.includes('admins') 
                        ? 'border-purple-300 bg-purple-50 text-purple-700'
                        : 'border-gray-300 bg-white text-gray-700'
                    )}
                  >
                    <option value="viewers">Viewer</option>
                    <option value="admins">Admin</option>
                  </select>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => setConfirmAction({ type: 'reset', user })}
                      className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                      title="Reset password"
                    >
                      <Key size={16} />
                    </button>
                    {user.enabled ? (
                      <button
                        onClick={() => setConfirmAction({ type: 'disable', user })}
                        className="p-1.5 text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded"
                        title="Disable user"
                      >
                        <UserX size={16} />
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmAction({ type: 'enable', user })}
                        className="p-1.5 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded"
                        title="Enable user"
                      >
                        <UserCheck size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => setConfirmAction({ type: 'delete', user })}
                      className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
                      title="Delete user"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {users.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No users found. Add your first user above.
          </div>
        )}
      </div>

      {/* Users cards - mobile */}
      <div className="md:hidden space-y-3">
        {users.length === 0 ? (
          <div className="text-center py-8 text-gray-500 border border-gray-200 rounded-lg">
            No users found. Add your first user above.
          </div>
        ) : (
          users.map((user) => (
            <div key={user.username} className="border border-gray-200 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">{user.email}</p>
                  {user.name && <p className="text-sm text-gray-500">{user.name}</p>}
                </div>
                {getStatusBadge(user)}
              </div>
              
              <div className="flex items-center justify-between gap-2">
                <select
                  value={user.groups.includes('admins') ? 'admins' : 'viewers'}
                  onChange={(e) => updateGroupMutation.mutate({
                    username: user.username,
                    group: e.target.value as 'admins' | 'viewers'
                  })}
                  disabled={updateGroupMutation.isPending}
                  className={clsx(
                    'text-sm border rounded px-2 py-1.5',
                    user.groups.includes('admins') 
                      ? 'border-purple-300 bg-purple-50 text-purple-700'
                      : 'border-gray-300 bg-white text-gray-700'
                  )}
                >
                  <option value="viewers">Viewer</option>
                  <option value="admins">Admin</option>
                </select>
                
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setConfirmAction({ type: 'reset', user })}
                    className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                    title="Reset password"
                  >
                    <Key size={18} />
                  </button>
                  {user.enabled ? (
                    <button
                      onClick={() => setConfirmAction({ type: 'disable', user })}
                      className="p-2 text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded"
                      title="Disable user"
                    >
                      <UserX size={18} />
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmAction({ type: 'enable', user })}
                      className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded"
                      title="Enable user"
                    >
                      <UserCheck size={18} />
                    </button>
                  )}
                  <button
                    onClick={() => setConfirmAction({ type: 'delete', user })}
                    className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
                    title="Delete user"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create user modal */}
      <CreateUserModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['users'] })}
      />

      {/* Confirm action modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        title={
          confirmAction?.type === 'delete' ? 'Delete User' :
          confirmAction?.type === 'disable' ? 'Disable User' :
          confirmAction?.type === 'enable' ? 'Enable User' :
          'Reset Password'
        }
        message={
          confirmAction?.type === 'delete' 
            ? `Are you sure you want to delete ${confirmAction.user.email}? This cannot be undone.`
            : confirmAction?.type === 'disable'
            ? `Disable ${confirmAction?.user.email}? They will not be able to log in.`
            : confirmAction?.type === 'enable'
            ? `Enable ${confirmAction?.user.email}? They will be able to log in again.`
            : `Send a password reset email to ${confirmAction?.user.email}?`
        }
        confirmLabel={
          confirmAction?.type === 'delete' ? 'Delete' :
          confirmAction?.type === 'disable' ? 'Disable' :
          confirmAction?.type === 'enable' ? 'Enable' :
          'Send Reset Email'
        }
        variant={confirmAction?.type === 'delete' ? 'danger' : 'info'}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
