/**
 * @fileoverview Modal for editing Cognito user attributes (first/last name).
 * @module components/UserAdmin/EditUserModal
 */

import { useMutation } from '@tanstack/react-query'
import {
  Pencil, AlertCircle,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import ModalShell from '../ModalShell/ModalShell'
import { useUnsavedChangesGuard } from '../UnsavedChangesGuard/useUnsavedChangesGuard'
import NameFields from './NameFields'
import UserDialogFooter from './UserDialogFooter'
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
  givenName, familyName, error,
  onGivenNameChange, onFamilyNameChange,
}: {
  readonly givenName: string
  readonly familyName: string
  readonly error: string
  readonly onGivenNameChange: (v: string) => void
  readonly onFamilyNameChange: (v: string) => void
}) {
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
        <div className="flex items-center gap-2 text-sm text-danger bg-danger-subtle p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
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
  const titleId = useId()

  const updateMutation = useEditUserMutation({
    user,
    givenName,
    familyName,
    onSuccess,
    onClose,
    setError,
  })
  const hasChanges = givenName !== (user.given_name ?? '') || familyName !== (user.family_name ?? '')
  const hasName = givenName.trim() !== '' || familyName.trim() !== ''
  const guard = useUnsavedChangesGuard({
    dirty: hasChanges,
    canSave: hasName,
    onSave: async () => (await updateMutation.mutateAsync()).success,
  })
  // Escape, the backdrop and Cancel ask first when the name was edited.
  const close = () => guard.requestLeave(onClose)

  // ModalShell (E2E F5 audit): this dialog was a bare overlay with no
  // role="dialog", no name and no focus trap; Escape came from useEscapeKey.
  return (
    <ModalShell isOpen onClose={close} ariaLabelledBy={titleId} panelClassName="max-w-md max-h-[90vh]">
        <div className="dialog-header">
          <Pencil size={20} className="text-accent shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h3 id={titleId} className="dialog-title">{t('userAdmin.editUser')}</h3>
            <p className="dialog-description truncate">{user.email}</p>
          </div>
        </div>

        <div className="dialog-body">
          <EditUserForm
            givenName={givenName}
            familyName={familyName}
            error={error}
            onGivenNameChange={setGivenName}
            onFamilyNameChange={setFamilyName}
          />
        </div>

        <UserDialogFooter
          onCancel={close}
          onConfirm={() => updateMutation.mutate()}
          confirmLabel={t('userAdmin.saveChanges')}
          confirmIcon={<Pencil size={16} />}
          isPending={updateMutation.isPending}
          disabled={!hasChanges || !hasName || updateMutation.isPending}
        />
        {guard.dialog}
    </ModalShell>
  )
}

export default function EditUserModal({
  isOpen, user, onClose, onSuccess,
}: EditUserModalProps) {
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
