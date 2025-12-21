/**
 * @fileoverview User Profile Modal component.
 *
 * Allows users to:
 * - View their profile info (email, name, groups)
 * - Change their password
 *
 * @module components/UserProfileModal
 */

import { useState } from 'react'
import { X, User, Shield, Eye, Lock, Loader2, CheckCircle2, AlertCircle, EyeOff } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { authService } from '../services/auth'
import clsx from 'clsx'

interface UserProfileModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function UserProfileModal({ isOpen, onClose }: UserProfileModalProps) {
  const { user } = useAuthStore()
  const [activeTab, setActiveTab] = useState<'profile' | 'password'>('profile')
  
  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [isChanging, setIsChanging] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  if (!isOpen || !user) return null

  const isAdmin = user.groups?.includes('admins')

  const handleChangePassword = async () => {
    setPasswordError('')
    setPasswordSuccess(false)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required')
      return
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match')
      return
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters')
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
      const error = err as Error
      if (error.message?.includes('Incorrect')) {
        setPasswordError('Current password is incorrect')
      } else {
        setPasswordError(error.message || 'Failed to change password')
      }
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <User size={20} className="text-blue-600" />
            My Profile
          </h3>
          <button
            onClick={handleClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab('profile')}
            className={clsx(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === 'profile'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            Profile
          </button>
          <button
            onClick={() => setActiveTab('password')}
            className={clsx(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === 'password'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            Change Password
          </button>
        </div>

        {/* Content - fixed height to prevent layout shift between tabs */}
        <div className="p-6 min-h-[480px]">
          {activeTab === 'profile' ? (
            <div className="space-y-4">
              {/* Avatar placeholder */}
              <div className="flex justify-center">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-2xl font-bold">
                  {user.name?.charAt(0).toUpperCase() || user.email?.charAt(0).toUpperCase() || 'U'}
                </div>
              </div>

              {/* User info */}
              <div className="space-y-3">
                {user.name && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Name</label>
                    <p className="text-gray-900 font-medium">{user.name}</p>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Email</label>
                  <p className="text-gray-900 font-medium">{user.email}</p>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Username</label>
                  <p className="text-gray-900">{user.username}</p>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Role</label>
                  <div className="flex items-center gap-2">
                    {isAdmin ? (
                      <>
                        <Shield size={16} className="text-purple-600" />
                        <span className="text-purple-700 font-medium">Administrator</span>
                      </>
                    ) : (
                      <>
                        <Eye size={16} className="text-gray-500" />
                        <span className="text-gray-700">Viewer</span>
                      </>
                    )}
                  </div>
                </div>

                {user.groups && user.groups.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Groups</label>
                    <div className="flex flex-wrap gap-2">
                      {user.groups.map((group) => (
                        <span
                          key={group}
                          className={clsx(
                            'px-2 py-1 text-xs rounded-full',
                            group === 'admins'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-gray-100 text-gray-700'
                          )}
                        >
                          {group}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
                <Lock size={16} />
                <span>Enter your current password and choose a new one</span>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current Password
                </label>
                <div className="relative">
                  <input
                    type={showPasswords ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="input pr-10"
                    placeholder="Enter current password"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type={showPasswords ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="input"
                  placeholder="Enter new password"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm New Password
                </label>
                <input
                  type={showPasswords ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="input"
                  placeholder="Confirm new password"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPasswords}
                  onChange={(e) => setShowPasswords(e.target.checked)}
                  className="rounded border-gray-300"
                />
                {showPasswords ? <EyeOff size={14} /> : <Eye size={14} />}
                Show passwords
              </label>

              {passwordError && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                  <AlertCircle size={16} />
                  {passwordError}
                </div>
              )}

              {passwordSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
                  <CheckCircle2 size={16} />
                  Password changed successfully!
                </div>
              )}

              <button
                onClick={handleChangePassword}
                disabled={isChanging || !currentPassword || !newPassword || !confirmPassword}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
              >
                {isChanging ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Lock size={16} />
                )}
                {isChanging ? 'Changing...' : 'Change Password'}
              </button>

              <p className="text-xs text-gray-500 text-center">
                Password must be at least 8 characters with uppercase, lowercase, and numbers
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
