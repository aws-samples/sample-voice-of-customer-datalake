/**
 * @fileoverview Login page with AWS Cognito authentication.
 *
 * Features:
 * - Username/password authentication
 * - New password challenge handling (first login)
 * - Forgot password flow with verification code
 * - Redirect to original destination after login
 *
 * @module pages/Login
 */

import { useState, type SyntheticEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { authService } from '../../services/auth'
import { CognitoUser } from 'amazon-cognito-identity-js'
import {
  LoginForm,
  NewPasswordForm,
  ForgotPasswordForm,
  ConfirmPasswordForm,
} from './LoginForms'

type AuthMode = 'login' | 'newPassword' | 'forgotPassword' | 'confirmPassword'

interface CognitoError {
  code?: string
  message?: string
  cognitoUser?: CognitoUser
}

function isCognitoError(err: unknown): err is CognitoError {
  return typeof err === 'object' && err !== null
}

function getFromPath(state: unknown): string {
  if (state && typeof state === 'object' && 'from' in state) {
    const fromValue = state.from
    if (typeof fromValue === 'string') return fromValue
  }
  return '/'
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (isCognitoError(err) && err.message) {
    return err.message
  }
  return fallback
}

// Auth Form Content - renders the appropriate form based on mode
interface AuthFormContentProps {
  readonly mode: AuthMode
  readonly username: string
  readonly password: string
  readonly newPassword: string
  readonly confirmNewPassword: string
  readonly verificationCode: string
  readonly showPassword: boolean
  readonly isLoading: boolean
  readonly error: string | null
  readonly message: string | null
  readonly onUsernameChange: (value: string) => void
  readonly onPasswordChange: (value: string) => void
  readonly onNewPasswordChange: (value: string) => void
  readonly onConfirmPasswordChange: (value: string) => void
  readonly onVerificationCodeChange: (value: string) => void
  readonly onToggleShowPassword: () => void
  readonly onSetShowPassword: (checked: boolean) => void
  readonly onLogin: (e: SyntheticEvent) => void
  readonly onNewPassword: (e: SyntheticEvent) => void
  readonly onForgotPassword: (e: SyntheticEvent) => void
  readonly onConfirmPassword: (e: SyntheticEvent) => void
  readonly onSwitchToForgotPassword: () => void
  readonly onBackToLogin: () => void
}

function AuthFormContent({
  mode,
  username,
  password,
  newPassword,
  confirmNewPassword,
  verificationCode,
  showPassword,
  isLoading,
  error,
  message,
  onUsernameChange,
  onPasswordChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onVerificationCodeChange,
  onToggleShowPassword,
  onSetShowPassword,
  onLogin,
  onNewPassword,
  onForgotPassword,
  onConfirmPassword,
  onSwitchToForgotPassword,
  onBackToLogin,
}: Readonly<AuthFormContentProps>) {
  if (mode === 'login') {
    return (
      <LoginForm
        username={username}
        password={password}
        showPassword={showPassword}
        isLoading={isLoading}
        error={error}
        message={message}
        onUsernameChange={onUsernameChange}
        onPasswordChange={onPasswordChange}
        onToggleShowPassword={onToggleShowPassword}
        onSubmit={onLogin}
        onForgotPassword={onSwitchToForgotPassword}
      />
    )
  }

  if (mode === 'newPassword') {
    return (
      <NewPasswordForm
        newPassword={newPassword}
        confirmNewPassword={confirmNewPassword}
        showPassword={showPassword}
        isLoading={isLoading}
        error={error}
        onNewPasswordChange={onNewPasswordChange}
        onConfirmPasswordChange={onConfirmPasswordChange}
        onToggleShowPassword={onSetShowPassword}
        onSubmit={onNewPassword}
      />
    )
  }

  if (mode === 'forgotPassword') {
    return (
      <ForgotPasswordForm
        username={username}
        isLoading={isLoading}
        error={error}
        onUsernameChange={onUsernameChange}
        onSubmit={onForgotPassword}
        onBackToLogin={onBackToLogin}
      />
    )
  }

  return (
    <ConfirmPasswordForm
      verificationCode={verificationCode}
      newPassword={newPassword}
      confirmNewPassword={confirmNewPassword}
      showPassword={showPassword}
      isLoading={isLoading}
      error={error}
      onVerificationCodeChange={onVerificationCodeChange}
      onNewPasswordChange={onNewPasswordChange}
      onConfirmPasswordChange={onConfirmPasswordChange}
      onSubmit={onConfirmPassword}
      onBackToLogin={onBackToLogin}
    />
  )
}

// Main Login Component
export default function Login() {
  const { t } = useTranslation('login')
  const navigate = useNavigate()
  const location = useLocation()
  const from = getFromPath(location.state)

  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [cognitoUser, setCognitoUser] = useState<CognitoUser | null>(null)

  const handleLogin = async (e: SyntheticEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      await authService.signIn(username, password)
      navigate(from, { replace: true })
    } catch (err: unknown) {
      if (isCognitoError(err) && err.code === 'NewPasswordRequired') {
        setCognitoUser(err.cognitoUser ?? null)
        setMode('newPassword')
        setError(null)
      } else {
        setError(extractErrorMessage(err, t('errors.loginFailed')))
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleNewPassword = async (e: SyntheticEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmNewPassword) {
      setError(t('errors.passwordsDoNotMatch'))
      return
    }

    if (newPassword.length < 8) {
      setError(t('errors.passwordTooShort'))
      return
    }

    if (cognitoUser == null) {
      setError(t('errors.sessionExpired'))
      setMode('login')
      return
    }

    setIsLoading(true)

    try {
      await authService.completeNewPassword(cognitoUser, newPassword)
      navigate(from, { replace: true })
    } catch (err: unknown) {
      setError(extractErrorMessage(err, t('errors.failedNewPassword')))
    } finally {
      setIsLoading(false)
    }
  }

  const handleForgotPassword = async (e: SyntheticEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setIsLoading(true)

    try {
      await authService.forgotPassword(username)
      setMessage(t('errors.verificationCodeSent'))
      setMode('confirmPassword')
    } catch (err: unknown) {
      setError(extractErrorMessage(err, t('errors.failedSendCode')))
    } finally {
      setIsLoading(false)
    }
  }

  const handleConfirmPassword = async (e: SyntheticEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmNewPassword) {
      setError(t('errors.passwordsDoNotMatch'))
      return
    }

    setIsLoading(true)

    try {
      await authService.confirmPassword(username, verificationCode, newPassword)
      setMessage(t('errors.passwordResetSuccess'))
      setMode('login')
      setPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setVerificationCode('')
    } catch (err: unknown) {
      setError(extractErrorMessage(err, t('errors.failedResetPassword')))
    } finally {
      setIsLoading(false)
    }
  }

  const handleSwitchToForgotPassword = () => {
    setMode('forgotPassword')
    setError(null)
    setMessage(null)
  }

  const handleBackToLogin = () => {
    setMode('login')
    setError(null)
  }

  const handleToggleShowPassword = () => {
    setShowPassword((prev) => !prev)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <MessageSquare className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{t('appName', { ns: 'common' })}</h1>
          <p className="text-gray-500 mt-1">{t('appTagline', { ns: 'common' })}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <AuthFormContent
            mode={mode}
            username={username}
            password={password}
            newPassword={newPassword}
            confirmNewPassword={confirmNewPassword}
            verificationCode={verificationCode}
            showPassword={showPassword}
            isLoading={isLoading}
            error={error}
            message={message}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onNewPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmNewPassword}
            onVerificationCodeChange={setVerificationCode}
            onToggleShowPassword={handleToggleShowPassword}
            onSetShowPassword={setShowPassword}
            onLogin={handleLogin}
            onNewPassword={handleNewPassword}
            onForgotPassword={handleForgotPassword}
            onConfirmPassword={handleConfirmPassword}
            onSwitchToForgotPassword={handleSwitchToForgotPassword}
            onBackToLogin={handleBackToLogin}
          />
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          {t('contactAdmin')}
        </p>
      </div>
    </div>
  )
}
