/**
 * @fileoverview Shared UI components for the Login page.
 * @module pages/Login/LoginSharedComponents
 */

import clsx from 'clsx'
import {
  Loader2, AlertCircle, Eye, EyeOff,
} from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

// Error Alert Component
interface ErrorAlertProps { readonly message: string }

export function ErrorAlert({ message }: Readonly<ErrorAlertProps>) {
  return (
    /*
     * This carried no role at all, so a screen-reader user got a red box they
     * were never told about. `role="alert"` fixes that for errors that APPEAR
     * — a failed sign-in, a password mismatch — which is nearly all of them.
     *
     * It does not help a message already present at mount (the session-expired
     * notice): a live region has to exist before its content is inserted to be
     * announced. Making that case announce needs focus management, which is a
     * bigger change than this component.
     */
    <div
      role="alert"
      className="flex items-center gap-2 text-danger text-sm bg-danger-subtle border border-danger/30 p-3 rounded-lg"
    >
      <AlertCircle size={16} />
      {message}
    </div>
  )
}

// Success Message Component
interface SuccessMessageProps { readonly message: string }

export function SuccessMessage({ message }: Readonly<SuccessMessageProps>) {
  return (
    <div className="text-ok text-sm bg-ok-subtle border border-ok/30 p-3 rounded-lg">
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

export function SubmitButton({
  isLoading, loadingText, text,
}: Readonly<SubmitButtonProps>) {
  return (
    <button
      type="submit"
      disabled={isLoading}
      className={clsx(
        'w-full btn btn-primary py-3 flex items-center justify-center gap-2',
        isLoading && 'opacity-75 cursor-not-allowed',
      )}
    >
      {isLoading ? <Loader2 size={18} className="animate-spin" /> : null}
      {isLoading ? loadingText : text}
    </button>
  )
}

// Labelled text field — the <label> is tied to its input so clicking it
// focuses the field and assistive tech announces the label, not the placeholder.
interface TextFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly label: string
  readonly placeholder: string
  readonly type?: 'text' | 'password'
  readonly autoComplete?: string
  readonly required?: boolean
  readonly minLength?: number
}

export function TextField({
  value, onChange, label, placeholder, type = 'text', autoComplete, required = true, minLength,
}: Readonly<TextFieldProps>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
      />
    </div>
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
  readonly autoComplete?: string
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
  autoComplete = 'current-password',
  required = true,
  minLength,
}: Readonly<PasswordInputProps>) {
  const { t } = useTranslation('login')
  const id = useId()
  const toggleLabel = showPassword ? t('hidePassword') : t('showPassword')
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input pr-11"
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={toggleLabel}
          aria-pressed={showPassword}
          title={toggleLabel}
          className="icon-btn absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center"
        >
          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  )
}
