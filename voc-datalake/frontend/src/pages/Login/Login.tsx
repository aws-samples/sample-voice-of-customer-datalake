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

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Loader2, AlertCircle, Eye, EyeOff, MessageSquare } from 'lucide-react'
import { authService } from '../../services/auth'
import { CognitoUser } from 'amazon-cognito-identity-js'
import clsx from 'clsx'

type AuthMode = 'login' | 'newPassword' | 'forgotPassword' | 'confirmPassword'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string })?.from || '/'

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
  
  // For new password challenge
  const [cognitoUser, setCognitoUser] = useState<CognitoUser | null>(null)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      await authService.signIn(username, password)
      navigate(from, { replace: true })
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string; cognitoUser?: CognitoUser }
      if (error.code === 'NewPasswordRequired') {
        setCognitoUser(error.cognitoUser || null)
        setMode('newPassword')
        setError(null)
      } else {
        setError(error.message || 'Login failed')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match')
      return
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (!cognitoUser) {
      setError('Session expired. Please login again.')
      setMode('login')
      return
    }

    setIsLoading(true)

    try {
      await authService.completeNewPassword(cognitoUser, newPassword)
      navigate(from, { replace: true })
    } catch (err: unknown) {
      const error = err as { message?: string }
      setError(error.message || 'Failed to set new password')
    } finally {
      setIsLoading(false)
    }
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setIsLoading(true)

    try {
      await authService.forgotPassword(username)
      setMessage('Verification code sent to your email')
      setMode('confirmPassword')
    } catch (err: unknown) {
      const error = err as { message?: string }
      setError(error.message || 'Failed to send verification code')
    } finally {
      setIsLoading(false)
    }
  }

  const handleConfirmPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match')
      return
    }

    setIsLoading(true)

    try {
      await authService.confirmPassword(username, verificationCode, newPassword)
      setMessage('Password reset successful. Please login.')
      setMode('login')
      setPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setVerificationCode('')
    } catch (err: unknown) {
      const error = err as { message?: string }
      setError(error.message || 'Failed to reset password')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo/Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <MessageSquare className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">VoC Analytics</h1>
          <p className="text-gray-500 mt-1">Voice of the Customer Analytics</p>
        </div>

        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Mode: Login */}
          {mode === 'login' && (
            <>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">Sign in</h2>
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Username or Email
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="input"
                    placeholder="Enter your username"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="input pr-10"
                      placeholder="Enter your password"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                )}

                {message && (
                  <div className="text-green-600 text-sm bg-green-50 p-3 rounded-lg">
                    {message}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className={clsx(
                    'w-full btn btn-primary py-3 flex items-center justify-center gap-2',
                    isLoading && 'opacity-75 cursor-not-allowed'
                  )}
                >
                  {isLoading && <Loader2 size={18} className="animate-spin" />}
                  {isLoading ? 'Signing in...' : 'Sign in'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('forgotPassword')
                    setError(null)
                    setMessage(null)
                  }}
                  className="w-full text-sm text-blue-600 hover:text-blue-700"
                >
                  Forgot password?
                </button>
              </form>
            </>
          )}

          {/* Mode: New Password Required */}
          {mode === 'newPassword' && (
            <>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Set New Password</h2>
              <p className="text-gray-500 text-sm mb-6">
                You need to set a new password for your account.
              </p>
              <form onSubmit={handleNewPassword} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    New Password
                  </label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
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
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    className="input"
                    placeholder="Confirm new password"
                    required
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(e) => setShowPassword(e.target.checked)}
                    className="rounded"
                  />
                  Show password
                </label>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full btn btn-primary py-3 flex items-center justify-center gap-2"
                >
                  {isLoading && <Loader2 size={18} className="animate-spin" />}
                  Set Password
                </button>
              </form>
            </>
          )}

          {/* Mode: Forgot Password */}
          {mode === 'forgotPassword' && (
            <>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Reset Password</h2>
              <p className="text-gray-500 text-sm mb-6">
                Enter your username to receive a verification code.
              </p>
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Username or Email
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="input"
                    placeholder="Enter your username"
                    required
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full btn btn-primary py-3 flex items-center justify-center gap-2"
                >
                  {isLoading && <Loader2 size={18} className="animate-spin" />}
                  Send Code
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('login')
                    setError(null)
                  }}
                  className="w-full text-sm text-gray-600 hover:text-gray-700"
                >
                  Back to login
                </button>
              </form>
            </>
          )}

          {/* Mode: Confirm Password Reset */}
          {mode === 'confirmPassword' && (
            <>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Enter Verification Code</h2>
              <p className="text-gray-500 text-sm mb-6">
                Check your email for the verification code.
              </p>
              <form onSubmit={handleConfirmPassword} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Verification Code
                  </label>
                  <input
                    type="text"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
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
                    onChange={(e) => setNewPassword(e.target.value)}
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
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    className="input"
                    placeholder="Confirm new password"
                    required
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full btn btn-primary py-3 flex items-center justify-center gap-2"
                >
                  {isLoading && <Loader2 size={18} className="animate-spin" />}
                  Reset Password
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('login')
                    setError(null)
                  }}
                  className="w-full text-sm text-gray-600 hover:text-gray-700"
                >
                  Back to login
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          Contact your administrator if you need access.
        </p>
      </div>
    </div>
  )
}
