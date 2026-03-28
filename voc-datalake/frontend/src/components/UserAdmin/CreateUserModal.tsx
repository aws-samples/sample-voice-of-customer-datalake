/**
 * @fileoverview Modal for creating new Cognito users.
 * @module components/UserAdmin/CreateUserModal
 */

import { useMutation } from '@tanstack/react-query'
import {
  UserPlus, Shield, Eye, Loader2, AlertCircle, Mail,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import NameFields from './NameFields'

type UserGroup = 'admins' | 'users'

interface CreateUserModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onSuccess: () => void
}

export default function CreateUserModal({
  isOpen, onClose, onSuccess,
}: CreateUserModalProps) {
  const { t } = useTranslation('components')
  const [email, setEmail] = useState('')
  const [givenName, setGivenName] = useState('')
  const [familyName, setFamilyName] = useState('')
  const [group, setGroup] = useState<UserGroup>('users')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const createMutation = useMutation({
    mutationFn: () => api.createUser({
      username: email,
      email,
      given_name: givenName,
      family_name: familyName,
      group,
    }),
    onSuccess: (data) => {
      if (data.success) {
        setEmail('')
        setGivenName('')
        setFamilyName('')
        setGroup('users')
        setError('')
        onSuccess()
        onClose()
      } else {
        setError(data.error != null && data.error !== '' ? data.error : 'Failed to create user')
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
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              {t('userAdmin.emailHelp')}
            </p>
          </div>

          <NameFields
            givenName={givenName}
            familyName={familyName}
            onGivenNameChange={setGivenName}
            onFamilyNameChange={setFamilyName}
          />

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

          {error === '' ? null : <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span>{error}</span>
          </div>}
        </div>

        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 mt-6">
          <button onClick={onClose} className="btn btn-secondary w-full sm:w-auto">
            {t('userAdmin.cancel')}
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={email === '' || createMutation.isPending}
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
