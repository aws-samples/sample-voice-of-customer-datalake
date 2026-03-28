/**
 * @fileoverview Modal for editing Cognito user attributes (first/last name).
 * @module components/UserAdmin/EditUserModal
 */

import { useMutation } from '@tanstack/react-query'
import {
  Pencil, Loader2, AlertCircle,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { CognitoUser } from '../../api/types'

interface EditUserModalProps {
  readonly isOpen: boolean
  readonly user: CognitoUser | null
  readonly onClose: () => void
  readonly onSuccess: () => void
}

export default function EditUserModal({
  isOpen, user, onClose, onSuccess,
}: EditUserModalProps) {
  const { t } = useTranslation('components')
  const [givenName, setGivenName] = useState('')
  const [familyName, setFamilyName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (user) {
      setGivenName(user.given_name)
      setFamilyName(user.family_name)
      setError('')
    }
  }, [user])

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!user) throw new Error('No user selected')
      return api.updateUser(user.username, {
        given_name: givenName,
        family_name: familyName,
      })
    },
    onSuccess: (data) => {
      if (data.success) {
        setError('')
        onSuccess()
        onClose()
      } else {
        setError(data.message || 'Failed to update user')
      }
    },
    onError: (err: Error) => setError(err.message),
  })

  if (!isOpen || !user) return null

  const hasChanges = givenName !== user.given_name || familyName !== user.family_name
  const hasName = givenName.trim() !== '' || familyName.trim() !== ''

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 sm:p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Pencil size={20} className="text-blue-600" />
          {t('userAdmin.editUser')}
        </h3>

        <p className="text-sm text-gray-500 mb-4">{user.email}</p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('userAdmin.firstNameLabel')}
            </label>
            <input
              type="text"
              value={givenName}
              onChange={(e) => setGivenName(e.target.value)}
              placeholder="Matias"
              className="input"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('userAdmin.lastNameLabel')}
            </label>
            <input
              type="text"
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              placeholder="Undurraga"
              className="input"
            />
          </div>

          {error === '' ? null : (
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
            onClick={() => updateMutation.mutate()}
            disabled={!hasChanges || !hasName || updateMutation.isPending}
            className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            {updateMutation.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Pencil size={16} />
            )}
            {t('userAdmin.saveChanges')}
          </button>
        </div>
      </div>
    </div>
  )
}
