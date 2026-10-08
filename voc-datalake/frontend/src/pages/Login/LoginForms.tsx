/**
 * @fileoverview Form components for the Login page.
 * @module pages/Login/LoginForms
 */

import { useTranslation } from 'react-i18next'
import {
  ErrorAlert, SuccessMessage, SubmitButton, PasswordInput, TextField,
} from './LoginSharedComponents'
import type { SyntheticEvent } from 'react'

// Shared field groups — each appears verbatim in more than one form below.

function UsernameField({ value, onChange }: Readonly<{
  value: string
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('login')
  return (
    <TextField
      label={t('usernameOrEmail')}
      value={value}
      onChange={onChange}
      placeholder={t('enterUsername')}
      autoComplete="username"
    />
  )
}

interface NewPasswordFieldsProps {
  readonly newPassword: string
  readonly confirmNewPassword: string
  readonly showPassword: boolean
  readonly onNewPasswordChange: (value: string) => void
  readonly onConfirmPasswordChange: (value: string) => void
}

function NewPasswordFields({
  newPassword,
  confirmNewPassword,
  showPassword,
  onNewPasswordChange,
  onConfirmPasswordChange,
}: Readonly<NewPasswordFieldsProps>) {
  const { t } = useTranslation('login')
  return (
    <>
      <TextField
        label={t('newPassword.label')}
        value={newPassword}
        onChange={onNewPasswordChange}
        placeholder={t('newPassword.placeholder')}
        type={showPassword ? 'text' : 'password'}
        autoComplete="new-password"
        minLength={8}
      />
      <TextField
        label={t('newPassword.confirmLabel')}
        value={confirmNewPassword}
        onChange={onConfirmPasswordChange}
        placeholder={t('newPassword.confirmPlaceholder')}
        type={showPassword ? 'text' : 'password'}
        autoComplete="new-password"
      />
    </>
  )
}

function BackToLoginButton({ onClick }: Readonly<{ onClick: () => void }>) {
  const { t } = useTranslation('login')
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-sm text-muted hover:text-text focus-ring rounded-md"
    >
      {t('resetPassword.backToLogin')}
    </button>
  )
}

// Login Form Component
export interface LoginFormProps {
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
      <h2 className="text-xl font-semibold tracking-tight text-text-strong mb-6">{t('signIn')}</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <UsernameField value={username} onChange={onUsernameChange} />
        <PasswordInput
          value={password}
          onChange={onPasswordChange}
          showPassword={showPassword}
          onToggleShow={onToggleShowPassword}
          placeholder={t('enterPassword')}
          label={t('password')}
          autoComplete="current-password"
        />

        {error != null && error !== '' ? <ErrorAlert message={error} /> : null}
        {message != null && message !== '' ? <SuccessMessage message={message} /> : null}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('signingIn')}
          text={t('signIn')}
        />

        <button
          type="button"
          onClick={onForgotPassword}
          className="w-full text-sm link focus-ring rounded-md"
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
      <h2 className="text-xl font-semibold tracking-tight text-text-strong mb-2">{t('newPassword.title')}</h2>
      <p className="text-muted text-sm mb-6">
        {t('newPassword.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <NewPasswordFields
          newPassword={newPassword}
          confirmNewPassword={confirmNewPassword}
          showPassword={showPassword}
          onNewPasswordChange={onNewPasswordChange}
          onConfirmPasswordChange={onConfirmPasswordChange}
        />

        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(e) => onToggleShowPassword(e.target.checked)}
            className="rounded-sm accent-accent"
          />
          {t('newPassword.showPassword')}
        </label>

        {error != null && error !== '' ? <ErrorAlert message={error} /> : null}

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
      <h2 className="text-xl font-semibold tracking-tight text-text-strong mb-2">{t('resetPassword.title')}</h2>
      <p className="text-muted text-sm mb-6">
        {t('resetPassword.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <UsernameField value={username} onChange={onUsernameChange} />

        {error != null && error !== '' ? <ErrorAlert message={error} /> : null}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('resetPassword.sendingCode')}
          text={t('resetPassword.sendCode')}
        />

        <BackToLoginButton onClick={onBackToLogin} />
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
      <h2 className="text-xl font-semibold tracking-tight text-text-strong mb-2">{t('verifyCode.title')}</h2>
      <p className="text-muted text-sm mb-6">
        {t('verifyCode.description')}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <TextField
          label={t('verifyCode.label')}
          value={verificationCode}
          onChange={onVerificationCodeChange}
          placeholder={t('verifyCode.placeholder')}
          autoComplete="one-time-code"
        />
        <NewPasswordFields
          newPassword={newPassword}
          confirmNewPassword={confirmNewPassword}
          showPassword={showPassword}
          onNewPasswordChange={onNewPasswordChange}
          onConfirmPasswordChange={onConfirmPasswordChange}
        />

        {error != null && error !== '' ? <ErrorAlert message={error} /> : null}

        <SubmitButton
          isLoading={isLoading}
          loadingText={t('verifyCode.resettingPassword')}
          text={t('verifyCode.submit')}
        />

        <BackToLoginButton onClick={onBackToLogin} />
      </form>
    </>
  )
}
