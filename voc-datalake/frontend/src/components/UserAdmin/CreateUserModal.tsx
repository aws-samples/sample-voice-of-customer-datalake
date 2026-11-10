/**
 * @fileoverview Modal for creating new Cognito users.
 * @module components/UserAdmin/CreateUserModal
 */

import { useMutation } from '@tanstack/react-query'
import {
  UserPlus, Shield, Eye, AlertCircle, Mail,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import ModalShell from '../ModalShell/ModalShell'
import NameFields from './NameFields'
import UserDialogFooter from './UserDialogFooter'

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

  const titleId = useId()

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

  // ModalShell (E2E F5 audit): this dialog was a bare overlay with no
  // role="dialog", no name and no focus trap; Escape came from useEscapeKey.
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-md max-h-[90vh]">
        <div className="dialog-header">
          <UserPlus size={20} className="text-accent shrink-0" aria-hidden="true" />
          <h3 id={titleId} className="dialog-title">{t('userAdmin.addNewUser')}</h3>
        </div>

        <div className="dialog-body space-y-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">
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
            <p className="text-xs text-muted mt-1">
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
            <label className="block text-sm font-medium text-text mb-1">
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
                  className="accent-accent"
                />
                <Eye size={16} className="text-muted" />
                <span>{t('userAdmin.userRole')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="group"
                  value="admins"
                  checked={group === 'admins'}
                  onChange={() => setGroup('admins')}
                  className="accent-accent"
                />
                <Shield size={16} className="text-aim" />
                <span>{t('userAdmin.adminRole')}</span>
              </label>
            </div>
          </div>

          {error === '' ? null : <div className="flex items-center gap-2 text-sm text-danger bg-danger-subtle p-3 rounded-lg">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span>{error}</span>
          </div>}
        </div>

        <UserDialogFooter
          onCancel={onClose}
          onConfirm={() => createMutation.mutate()}
          confirmLabel={t('userAdmin.sendInvite')}
          confirmIcon={<Mail size={16} />}
          isPending={createMutation.isPending}
          disabled={email === '' || createMutation.isPending}
        />
    </ModalShell>
  )
}
