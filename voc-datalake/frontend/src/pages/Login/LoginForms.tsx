/**
 * @fileoverview Form components for the Login page.
 * @module pages/Login/LoginForms
 */

import type { SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorAlert, SuccessMessage, SubmitButton, PasswordInput } from './LoginSharedComponents'

// Login Form Component
interface LoginFormProps {
  readonly username: string
  readonly password: string
  readonly showPassword: boolean
  readonly isLoading: boolean
  readonly error: string | null
  readonly message: string | null
  readonly onUsernameChange: (value: string) => void
  readonly onPasswordChange: (value: string) => void
  readonly onToggleShowPassword: () => void
  readonly onSubmit: (e: SyntheticEvent) => void
  readonly onForgotPassword: () => void
}

export function LoginForm({
  username,
  password,
  showPassword,
  isLoading,
  error,
  message,
  onUsernameChange,
  onPasswordChange,
  onToggleShowPassword,
  onSubmit,
  onForgotPassword,
}: Readonly<LoginFormProps>) {
  const { t } = useTranslation('login')
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('signIn')}</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('usernameOrEmail')}
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="input"
            placeholder={t('enterUsername')}
            required
            autoFocus
          />
        </div>
        <PasswordInput
          value={password}
          onChange={onPasswordChange}
          showPassword={showPassword}
          onToggleShow={onToggleShowPassword}
          placeholder={t('enterPassword')}
          label={t('password')}
        />

        {error && <ErrorAlert message={error} />}
        {message && <SuccessMessage message={message} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('signingIn')}
          text={t('signIn')}
        />

        <button
          type="button"
          onClick={onForgotPassword}
          className="w-full text-sm text-blue-600 hover:text-blue-700"
        >
          {t('forgotPassword')}
        </button>
      </form>
    </>
  )
}

// New Password Form Component
interface NewPasswordFormProps {
  readonly newPassword: string
  readonly confirmNewPassword: string
  readonly showPassword: boolean
  readonly isLoading: boolean
  readonly error: string | null
  readonly onNewPasswordChange: (value: string) => void
  readonly onConfirmPasswordChange: (value: string) => void
  readonly onToggleShowPassword: (checked: boolean) => void
  readonly onSubmit: (e: SyntheticEvent) => void
}

export function NewPasswordForm({
  newPassword,
  confirmNewPassword,
  showPassword,
  isLoading,
  error,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onToggleShowPassword,
  onSubmit,
}: Readonly<NewPasswordFormProps>) {
  const { t } = useTranslation('login')
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('newPassword.title')}</h2>
      <p className="text-gray-500 text-sm mb-6">
        {t('newPassword.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('newPassword.label')}
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => onNewPasswordChange(e.target.value)}
            className="input"
            placeholder={t('newPassword.placeholder')}
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('newPassword.confirmLabel')}
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmNewPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="input"
            placeholder={t('newPassword.confirmPlaceholder')}
            required
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(e) => onToggleShowPassword(e.target.checked)}
            className="rounded"
          />
          {t('newPassword.showPassword')}
        </label>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('newPassword.settingPassword')}
          text={t('newPassword.submit')}
        />
      </form>
    </>
  )
}

// Forgot Password Form Component
interface ForgotPasswordFormProps {
  readonly username: string
  readonly isLoading: boolean
  readonly error: string | null
  readonly onUsernameChange: (value: string) => void
  readonly onSubmit: (e: SyntheticEvent) => void
  readonly onBackToLogin: () => void
}

export function ForgotPasswordForm({
  username,
  isLoading,
  error,
  onUsernameChange,
  onSubmit,
  onBackToLogin,
}: Readonly<ForgotPasswordFormProps>) {
  const { t } = useTranslation('login')
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('resetPassword.title')}</h2>
      <p className="text-gray-500 text-sm mb-6">
        {t('resetPassword.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('usernameOrEmail')}
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="input"
            placeholder={t('enterUsername')}
            required
          />
        </div>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('resetPassword.sendingCode')}
          text={t('resetPassword.sendCode')}
        />

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full text-sm text-gray-600 hover:text-gray-700"
        >
          {t('resetPassword.backToLogin')}
        </button>
      </form>
    </>
  )
}

// Confirm Password Form Component
interface ConfirmPasswordFormProps {
  readonly verificationCode: string
  readonly newPassword: string
  readonly confirmNewPassword: string
  readonly showPassword: boolean
  readonly isLoading: boolean
  readonly error: string | null
  readonly onVerificationCodeChange: (value: string) => void
  readonly onNewPasswordChange: (value: string) => void
  readonly onConfirmPasswordChange: (value: string) => void
  readonly onSubmit: (e: SyntheticEvent) => void
  readonly onBackToLogin: () => void
}

export function ConfirmPasswordForm({
  verificationCode,
  newPassword,
  confirmNewPassword,
  showPassword,
  isLoading,
  error,
  onVerificationCodeChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
  onBackToLogin,
}: Readonly<ConfirmPasswordFormProps>) {
  const { t } = useTranslation('login')
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('verifyCode.title')}</h2>
      <p className="text-gray-500 text-sm mb-6">
        {t('verifyCode.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('verifyCode.label')}
          </label>
          <input
            type="text"
            value={verificationCode}
            onChange={(e) => onVerificationCodeChange(e.target.value)}
            className="input"
            placeholder={t('verifyCode.placeholder')}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('newPassword.label')}
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => onNewPasswordChange(e.target.value)}
            className="input"
            placeholder={t('newPassword.placeholder')}
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('newPassword.confirmLabel')}
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmNewPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="input"
            placeholder={t('newPassword.confirmPlaceholder')}
            required
          />
        </div>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('verifyCode.resettingPassword')}
          text={t('verifyCode.submit')}
        />

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full text-sm text-gray-600 hover:text-gray-700"
        >
          {t('resetPassword.backToLogin')}
        </button>
      </form>
    </>
  )
}
