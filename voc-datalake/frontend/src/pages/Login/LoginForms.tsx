/**
 * @fileoverview Form components for the Login page.
 * @module pages/Login/LoginForms
 */

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
  readonly onSubmit: (e: React.SyntheticEvent) => void
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
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Sign in</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Username or Email
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="input"
            placeholder="Enter your username"
            required
            autoFocus
          />
        </div>
        <PasswordInput
          value={password}
          onChange={onPasswordChange}
          showPassword={showPassword}
          onToggleShow={onToggleShowPassword}
          placeholder="Enter your password"
          label="Password"
        />

        {error && <ErrorAlert message={error} />}
        {message && <SuccessMessage message={message} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText="Signing in..."
          text="Sign in"
        />

        <button
          type="button"
          onClick={onForgotPassword}
          className="w-full text-sm text-blue-600 hover:text-blue-700"
        >
          Forgot password?
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
  readonly onSubmit: (e: React.SyntheticEvent) => void
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
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Set New Password</h2>
      <p className="text-gray-500 text-sm mb-6">
        You need to set a new password for your account.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            New Password
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => onNewPasswordChange(e.target.value)}
            className="input"
            placeholder="Enter new password"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Confirm Password
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmNewPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="input"
            placeholder="Confirm new password"
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
          Show password
        </label>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText="Setting password..."
          text="Set Password"
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
  readonly onSubmit: (e: React.SyntheticEvent) => void
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
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Reset Password</h2>
      <p className="text-gray-500 text-sm mb-6">
        Enter your username to receive a verification code.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Username or Email
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="input"
            placeholder="Enter your username"
            required
          />
        </div>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText="Sending code..."
          text="Send Code"
        />

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full text-sm text-gray-600 hover:text-gray-700"
        >
          Back to login
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
  readonly onSubmit: (e: React.SyntheticEvent) => void
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
  return (
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Enter Verification Code</h2>
      <p className="text-gray-500 text-sm mb-6">
        Check your email for the verification code.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Verification Code
          </label>
          <input
            type="text"
            value={verificationCode}
            onChange={(e) => onVerificationCodeChange(e.target.value)}
            className="input"
            placeholder="Enter code"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            New Password
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => onNewPasswordChange(e.target.value)}
            className="input"
            placeholder="Enter new password"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Confirm Password
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmNewPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="input"
            placeholder="Confirm new password"
            required
          />
        </div>

        {error && <ErrorAlert message={error} />}

        <SubmitButton
          isLoading={isLoading}
          loadingText="Resetting password..."
          text="Reset Password"
        />

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full text-sm text-gray-600 hover:text-gray-700"
        >
          Back to login
        </button>
      </form>
    </>
  )
}
