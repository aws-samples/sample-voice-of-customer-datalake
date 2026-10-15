/**
 * @fileoverview Modal for editing Cognito user attributes (first/last name).
 * @module components/UserAdmin/EditUserModal
 */

import { useMutation } from '@tanstack/react-query'
import {
  Pencil, Loader2, AlertCircle,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import NameFields from './NameFields'
import type { CognitoUser } from '../../api/types'

interface EditUserModalProps {
  readonly isOpen: boolean
  readonly user: CognitoUser | null
  readonly onClose: () => void
  readonly onSuccess: () => void
}

function useEditUserMutation(opts: {
  user: CognitoUser
  givenName: string
  familyName: string
  onSuccess: () => void
  onClose: () => void
  setError: (msg: string) => void
}) {
  return useMutation({
    mutationFn: () => api.updateUser(opts.user.username, {
      given_name: opts.givenName,
      family_name: opts.familyName,
    }),
    onSuccess: (data) => {
      if (data.success) {
        opts.setError('')
        opts.onSuccess()
        opts.onClose()
      } else {
        const msg = typeof data.message === 'string' && data.message !== '' ? data.message : 'Failed to update user'
        opts.setError(msg)
      }
    },
    onError: (err: Error) => opts.setError(err.message),
  })
}

function EditUserForm({
  user, givenName, familyName, error,
  onGivenNameChange, onFamilyNameChange, onSubmit, isPending,
}: {
  readonly user: CognitoUser
  readonly givenName: string
  readonly familyName: string
  readonly error: string
  readonly onGivenNameChange: (v: string) => void
  readonly onFamilyNameChange: (v: string) => void
  readonly onSubmit: () => void
  readonly isPending: boolean
}) {
  const { t } = useTranslation('components')
  const hasChanges = givenName !== (user.given_name ?? '') || familyName !== (user.family_name ?? '')
  const hasName = givenName.trim() !== '' || familyName.trim() !== ''

  return (
    <div className="space-y-4">
      <NameFields
        givenName={givenName}
        familyName={familyName}
        onGivenNameChange={onGivenNameChange}
        onFamilyNameChange={onFamilyNameChange}
        autoFocusFirst
      />

      {error === '' ? null : (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 mt-6">
        <button
          onClick={onSubmit}
          disabled={!hasChanges || !hasName || isPending}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          {isPending ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Pencil size={16} />
          )}
          {t('userAdmin.saveChanges')}
        </button>
      </div>
    </div>
  )
}

function EditUserModalContent({
  user, onClose, onSuccess,
}: {
  readonly user: CognitoUser;
  readonly onClose: () => void;
  readonly onSuccess: () => void
}) {
  const { t } = useTranslation('components')
  const [givenName, setGivenName] = useState(user.given_name ?? '')
  const [familyName, setFamilyName] = useState(user.family_name ?? '')
  const [error, setError] = useState('')

  const updateMutation = useEditUserMutation({
    user,
    givenName,
    familyName,
    onSuccess,
    onClose,
    setError,
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 sm:p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Pencil size={20} className="text-blue-600" />
          {t('userAdmin.editUser')}
        </h3>

        <p className="text-sm text-gray-500 mb-4">{user.email}</p>

        <EditUserForm
          user={user}
          givenName={givenName}
          familyName={familyName}
          error={error}
          onGivenNameChange={setGivenName}
          onFamilyNameChange={setFamilyName}
          onSubmit={() => updateMutation.mutate()}
          isPending={updateMutation.isPending}
        />

        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 mt-2">
          <button onClick={onClose} className="btn btn-secondary w-full sm:w-auto">
            {t('userAdmin.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function EditUserModal({
  isOpen, user, onClose, onSuccess,
}: EditUserModalProps) {
  useEscapeKey(isOpen, onClose)

  if (!isOpen || !user) return null

  return (
    <EditUserModalContent
      key={user.username}
      user={user}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  )
}
