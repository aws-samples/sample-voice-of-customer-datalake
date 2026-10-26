/**
 * @fileoverview Icon-only close button for a dialog header (KiroCrew
 * `dialog-close` recipe). One component so every dialog's X carries an
 * accessible name. By default it uses "Dismiss" rather than "Close" so it never
 * collides with a footer "Close"/"Cancel" button when tests or screen readers
 * query by role and name. Pass `label` when the surface already has a "Dismiss"
 * control of its own (the assistant panel next to an approval card).
 * @module components/DialogClose
 */
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function DialogClose({
  onClick,
  disabled,
  className,
  label,
}: Readonly<{
  onClick: () => void
  disabled?: boolean
  className?: string
  /** Accessible name (already translated). Defaults to the common "Dismiss". */
  label?: string
}>) {
  const { t } = useTranslation('common')
  const name = label ?? t('dismiss')
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx('dialog-close focus-ring', className)}
      aria-label={name}
      title={name}
    >
      <X size={16} aria-hidden />
    </button>
  )
}
