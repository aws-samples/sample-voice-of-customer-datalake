/**
 * @fileoverview Shared UI components for the Login page.
 * @module pages/Login/LoginSharedComponents
 */

import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react'
import clsx from 'clsx'

// Error Alert Component
interface ErrorAlertProps {
  readonly message: string
}

export function ErrorAlert({ message }: Readonly<ErrorAlertProps>) {
  return (
    <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
      <AlertCircle size={16} />
      {message}
    </div>
  )
}

// Success Message Component
interface SuccessMessageProps {
  readonly message: string
}

export function SuccessMessage({ message }: Readonly<SuccessMessageProps>) {
  return (
    <div className="text-green-600 text-sm bg-green-50 p-3 rounded-lg">
      {message}
    </div>
  )
}

// Submit Button Component
interface SubmitButtonProps {
  readonly isLoading: boolean
  readonly loadingText: string
  readonly text: string
}

export function SubmitButton({ isLoading, loadingText, text }: Readonly<SubmitButtonProps>) {
  return (
    <button
      type="submit"
      disabled={isLoading}
      className={clsx(
        'w-full btn btn-primary py-3 flex items-center justify-center gap-2',
        isLoading && 'opacity-75 cursor-not-allowed'
      )}
    >
      {isLoading && <Loader2 size={18} className="animate-spin" />}
      {isLoading ? loadingText : text}
    </button>
  )
}

// Password Input Component
interface PasswordInputProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly showPassword: boolean
  readonly onToggleShow: () => void
  readonly placeholder: string
  readonly label: string
  readonly required?: boolean
  readonly minLength?: number
}

export function PasswordInput({
  value,
  onChange,
  showPassword,
  onToggleShow,
  placeholder,
  label,
  required = true,
  minLength,
}: Readonly<PasswordInputProps>) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input pr-10"
          placeholder={placeholder}
          required={required}
          minLength={minLength}
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        >
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </div>
  )
}
