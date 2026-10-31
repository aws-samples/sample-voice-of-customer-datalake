/**
 * @fileoverview Form components for the Login page.
 * @module pages/Login/LoginForms
 */

import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ErrorAlert, SuccessMessage, SubmitButton, PasswordInput, TextField,
} from './LoginSharedComponents'
import type { ReactNode, SyntheticEvent } from 'react'

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

interface AuthFormFrameProps {
  readonly title: string
  /** The line under the title; the sign-in form has none. */
  readonly description?: string
  readonly error: string | null
  /** Shown under the error (the sign-in form's "password changed" notice). */
  readonly notice?: ReactNode
  readonly submit: { readonly isLoading: boolean; readonly loadingText: string; readonly text: string }
  readonly onSubmit: (e: SyntheticEvent) => void
  /** The form's fields, above the error. */
  readonly children: ReactNode
  /** Under the submit button (the back / forgot-password link). */
  readonly footer?: ReactNode
}

/** The frame every auth form shares: title, description, fields, error, submit, footer. */
function AuthFormFrame({
  title, description, error, notice, submit, onSubmit, children, footer,
}: Readonly<AuthFormFrameProps>) {
  return (
    <>
      <h2 className={`text-xl font-semibold tracking-tight text-text-strong ${description === undefined ? 'mb-6' : 'mb-2'}`}>{title}</h2>
      {description === undefined ? null : <p className="text-muted text-sm mb-6">{description}</p>}
      <form onSubmit={onSubmit} className="space-y-4">
        {children}
        {error != null && error !== '' ? <ErrorAlert message={error} /> : null}
        {notice}
        <SubmitButton isLoading={submit.isLoading} loadingText={submit.loadingText} text={submit.text} />
        {footer}
      </form>
    </>
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
  /** Present when passkeys can be used here (services/passkeyAuth canUsePasskeys): shows the passkey button. */
  readonly onPasskeySignIn?: () => void
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
  onPasskeySignIn,
}: Readonly<LoginFormProps>) {
  const { t } = useTranslation('login')
  return (
    <AuthFormFrame
      title={t('signIn')}
      error={error}
      notice={message != null && message !== '' ? <SuccessMessage message={message} /> : null}
      submit={{ isLoading, loadingText: t('signingIn'), text: t('signIn') }}
      onSubmit={onSubmit}
      footer={(
        <>
          {onPasskeySignIn && (
            <button
              type="button"
              onClick={onPasskeySignIn}
              disabled={isLoading}
              className="btn btn-secondary w-full py-2 gap-2"
            >
              <KeyRound size={16} aria-hidden="true" />
              {t('passkey.signIn')}
            </button>
          )}
          <button
            type="button"
            onClick={onForgotPassword}
            className="w-full text-sm link focus-ring rounded-md"
          >
            {t('forgotPassword')}
          </button>
        </>
      )}
    >
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
    </AuthFormFrame>
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
    <AuthFormFrame
      title={t('newPassword.title')}
      description={t('newPassword.description')}
      error={error}
      submit={{ isLoading, loadingText: t('newPassword.settingPassword'), text: t('newPassword.submit') }}
      onSubmit={onSubmit}
    >
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
    </AuthFormFrame>
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
    <AuthFormFrame
      title={t('resetPassword.title')}
      description={t('resetPassword.description')}
      error={error}
      submit={{ isLoading, loadingText: t('resetPassword.sendingCode'), text: t('resetPassword.sendCode') }}
      onSubmit={onSubmit}
      footer={<BackToLoginButton onClick={onBackToLogin} />}
    >
      <UsernameField value={username} onChange={onUsernameChange} />
    </AuthFormFrame>
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
    <AuthFormFrame
      title={t('verifyCode.title')}
      description={t('verifyCode.description')}
      error={error}
      submit={{ isLoading, loadingText: t('verifyCode.resettingPassword'), text: t('verifyCode.submit') }}
      onSubmit={onSubmit}
      footer={<BackToLoginButton onClick={onBackToLogin} />}
    >
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
    </AuthFormFrame>
  )
}
