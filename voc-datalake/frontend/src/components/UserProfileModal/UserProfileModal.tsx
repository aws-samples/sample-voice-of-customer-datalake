/**
 * @fileoverview User Profile Modal component.
 *
 * Allows users to:
 * - View their profile info (email, name, groups)
 * - Change their password
 *
 * @module components/UserProfileModal
 */

import clsx from 'clsx'
import {
  X, User, Shield, Eye, Lock, Loader2, CheckCircle2, AlertCircle, EyeOff,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authService } from '../../services/auth'
import { useAuthStore } from '../../store/authStore'

interface UserProfileModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
}

function getPasswordError(err: unknown, t: (key: string) => string): string {
  if (err instanceof Error) {
    if (err.message.includes('Incorrect')) return t('userProfile.incorrectPassword')
    return err.message === '' ? t('userProfile.failedToChange') : err.message
  }
  return t('userProfile.failedToChange')
}

function validatePasswordChange(current: string, newPwd: string, confirm: string, t: (key: string) => string): string | null {
  if (current === '' || newPwd === '' || confirm === '') return t('userProfile.allFieldsRequired')
  if (newPwd !== confirm) return t('userProfile.passwordsMismatch')
  if (newPwd.length < 8) return t('userProfile.passwordTooShort')
  return null
}

// Avatar component
function UserAvatar({
  name, email,
}: Readonly<{
  name?: string;
  email?: string
}>) {
  const initial = (name?.charAt(0).toUpperCase() ?? email?.charAt(0).toUpperCase()) ?? 'U'
  return (
    <div className="flex justify-center">
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl sm:text-2xl font-bold">
        {initial}
      </div>
    </div>
  )
}

// Info field component
function InfoField({
  label, children,
}: Readonly<{
  label: string;
  children: React.ReactNode
}>) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

// Role display component
function RoleDisplay({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('components')
  if (isAdmin) {
    return (
      <div className="flex items-center gap-2">
        <Shield size={16} className="text-purple-600 flex-shrink-0" />
        <span className="text-purple-700 font-medium">{t('userProfile.administrator')}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Eye size={16} className="text-gray-500 flex-shrink-0" />
      <span className="text-gray-700">{t('userProfile.user')}</span>
    </div>
  )
}

// Groups display component
function GroupsDisplay({ groups }: Readonly<{ groups: string[] }>) {
  const { t } = useTranslation('components')
  if (groups.length === 0) return null
  return (
    <InfoField label={t('userProfile.groups')}>
      <div className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <span
            key={group}
            className={clsx(
              'px-2 py-1 text-xs rounded-full',
              group === 'admins' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700',
            )}
          >
            {group}
          </span>
        ))}
      </div>
    </InfoField>
  )
}

// Profile tab content
function ProfileTab({
  user, isAdmin,
}: Readonly<{
  user: {
    name?: string;
    email?: string;
    username?: string;
    groups?: string[]
  };
  isAdmin: boolean
}>) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-4">
      <UserAvatar name={user.name} email={user.email} />
      <div className="space-y-3">
        {user.name != null && user.name !== '' ? <InfoField label={t('userProfile.name')}>
          <p className="text-gray-900 font-medium truncate">{user.name}</p>
        </InfoField> : null}
        <InfoField label={t('userProfile.email')}>
          <p className="text-gray-900 font-medium truncate">{user.email}</p>
        </InfoField>
        <InfoField label={t('userProfile.username')}>
          <p className="text-gray-900 truncate">{user.username}</p>
        </InfoField>
        <InfoField label={t('userProfile.role')}>
          <RoleDisplay isAdmin={isAdmin} />
        </InfoField>
        <GroupsDisplay groups={user.groups ?? []} />
      </div>
    </div>
  )
}

// Password input component
function PasswordInput({
  id,
  label,
  value,
  onChange,
  showPassword,
  placeholder,
}: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  showPassword: boolean
  placeholder: string
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <input
        id={id}
        type={showPassword ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
      />
    </div>
  )
}

// Password tab content
function PasswordTab({
  currentPassword,
  newPassword,
  confirmPassword,
  showPasswords,
  isChanging,
  passwordError,
  passwordSuccess,
  onCurrentChange,
  onNewChange,
  onConfirmChange,
  onShowPasswordsChange,
  onSubmit,
}: Readonly<{
  currentPassword: string
  newPassword: string
  confirmPassword: string
  showPasswords: boolean
  isChanging: boolean
  passwordError: string
  passwordSuccess: boolean
  onCurrentChange: (v: string) => void
  onNewChange: (v: string) => void
  onConfirmChange: (v: string) => void
  onShowPasswordsChange: (v: boolean) => void
  onSubmit: () => void
}>) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
        <Lock size={16} />
        <span>{t('userProfile.passwordIntro')}</span>
      </div>

      <PasswordInput id="current-password" label={t('userProfile.currentPassword')} value={currentPassword} onChange={onCurrentChange} showPassword={showPasswords} placeholder={t('userProfile.currentPasswordPlaceholder')} />
      <PasswordInput id="new-password" label={t('userProfile.newPassword')} value={newPassword} onChange={onNewChange} showPassword={showPasswords} placeholder={t('userProfile.newPasswordPlaceholder')} />
      <PasswordInput id="confirm-password" label={t('userProfile.confirmNewPassword')} value={confirmPassword} onChange={onConfirmChange} showPassword={showPasswords} placeholder={t('userProfile.confirmPasswordPlaceholder')} />

      <label htmlFor="show-passwords" className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
        <input id="show-passwords" type="checkbox" checked={showPasswords} onChange={(e) => onShowPasswordsChange(e.target.checked)} className="rounded border-gray-300" />
        {showPasswords ? <EyeOff size={14} /> : <Eye size={14} />}
        {t('userProfile.showPasswords')}
      </label>

      {passwordError === '' ? null : <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
        <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
        <span>{passwordError}</span>
      </div>}

      {passwordSuccess ? <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
        <CheckCircle2 size={16} className="flex-shrink-0" />
        {t('userProfile.passwordChanged')}
      </div> : null}

      <button
        onClick={onSubmit}
        disabled={isChanging || currentPassword === '' || newPassword === '' || confirmPassword === ''}
        className="btn btn-primary w-full flex items-center justify-center gap-2 py-2.5"
      >
        {isChanging ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
        {isChanging ? t('userProfile.changing') : t('userProfile.changePassword')}
      </button>

      <p className="text-xs text-gray-500 text-center">
        {t('userProfile.passwordRequirements')}
      </p>
    </div>
  )
}

export default function UserProfileModal({
  isOpen, onClose,
}: UserProfileModalProps) {
  const { t } = useTranslation('components')
  const { user } = useAuthStore()
  const [activeTab, setActiveTab] = useState<'profile' | 'password'>('profile')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [isChanging, setIsChanging] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  if (!isOpen || !user) return null

  const isAdmin = user.groups.includes('admins')

  const handleChangePassword = async () => {
    setPasswordError('')
    setPasswordSuccess(false)

    const validationError = validatePasswordChange(currentPassword, newPassword, confirmPassword, t)
    if (validationError != null && validationError !== '') {
      setPasswordError(validationError)
      return
    }

    setIsChanging(true)
    try {
      await authService.changePassword(currentPassword, newPassword)
      setPasswordSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordSuccess(false), 3000)
    } catch (err) {
      setPasswordError(getPasswordError(err, t))
    } finally {
      setIsChanging(false)
    }
  }

  const handleClose = () => {
    setActiveTab('profile')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordError('')
    setPasswordSuccess(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <User size={20} className="text-blue-600" />
            {t('userProfile.myProfile')}
          </h3>
          <button onClick={handleClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
            <X size={20} />
          </button>
        </div>

        <div className="flex border-b border-gray-200 flex-shrink-0">
          <button
            onClick={() => setActiveTab('profile')}
            className={clsx('flex-1 px-4 py-3 text-sm font-medium transition-colors', activeTab === 'profile' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700')}
          >
            {t('userProfile.profile')}
          </button>
          <button
            onClick={() => setActiveTab('password')}
            className={clsx('flex-1 px-4 py-3 text-sm font-medium transition-colors', activeTab === 'password' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700')}
          >
            {t('userProfile.changePassword')}
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1">
          {activeTab === 'profile' ? (
            <ProfileTab user={user} isAdmin={isAdmin} />
          ) : (
            <PasswordTab
              currentPassword={currentPassword}
              newPassword={newPassword}
              confirmPassword={confirmPassword}
              showPasswords={showPasswords}
              isChanging={isChanging}
              passwordError={passwordError}
              passwordSuccess={passwordSuccess}
              onCurrentChange={setCurrentPassword}
              onNewChange={setNewPassword}
              onConfirmChange={setConfirmPassword}
              onShowPasswordsChange={setShowPasswords}
              onSubmit={() => void handleChangePassword()}
            />
          )}
        </div>
      </div>
    </div>
  )
}
