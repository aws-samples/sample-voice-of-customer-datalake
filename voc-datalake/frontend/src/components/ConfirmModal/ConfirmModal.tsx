/**
 * @fileoverview Confirmation modal component.
 *
 * Reusable modal for confirming destructive actions:
 * - Danger, warning, and info variants
 * - Loading state support
 * - Customizable labels
 *
 * @module components/ConfirmModal
 */

import type { ReactNode } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import ModalShell from '../ModalShell/ModalShell'

interface ConfirmModalProps {
  isOpen: boolean
  title: string
  message: string
  /**
   * Optional detail rendered under the message, above the buttons — for a
   * confirmation that needs the user to inspect or adjust something before
   * answering, rather than only to read.
   *
   * Deliberately additive: `message` stays required, so a dialog cannot end up
   * with controls and no question. Every existing caller is unaffected.
   *
   * Rendered with no wrapper element. A wrapper carrying its own margin would
   * leave a visible gap whenever the child COMPONENT returns null — which
   * `children != null` cannot detect, since a React element that renders nothing
   * is still a non-null child. Spacing therefore belongs to the child.
   */
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'warning' | 'info'
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  children,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  isLoading = false,
  onConfirm,
  onCancel,
}: Readonly<ConfirmModalProps>) {
  const { t } = useTranslation()
  if (!isOpen) return null

  const variantStyles = {
    danger: {
      icon: 'bg-danger-subtle text-danger',
      button: 'btn btn-danger-solid',
    },
    warning: {
      icon: 'bg-warn-subtle text-warn',
      button: 'btn btn-primary',
    },
    info: {
      icon: 'bg-info-subtle text-info',
      button: 'btn btn-primary',
    },
  }

  const styles = variantStyles[variant]

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onCancel}
      ariaLabel={title}
      panelClassName="max-w-md"
      // An in-flight confirmation must not be dismissable: closing the dialog
      // would not cancel the work it already started.
      dismissable={!isLoading}
    >
      <div className="p-4 sm:p-6">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className={clsx('w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center flex-shrink-0', styles.icon)}>
            <AlertTriangle size={18} className="sm:w-5 sm:h-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            {/* `whitespace-normal` undoes the recipe's truncate: a confirmation
                title is the question being asked and must never be elided. */}
            <h2 className="dialog-title whitespace-normal">{title}</h2>
            <p className="dialog-description mt-2 text-sm">{message}</p>
            {children}
          </div>
        </div>
      </div>

      <div className="dialog-footer flex-col-reverse sm:flex-row sm:gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="btn btn-secondary py-2.5 sm:py-2 w-full sm:w-auto"
        >
          {cancelLabel ?? t('common:cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isLoading}
          className={clsx('py-2.5 sm:py-2 gap-2 w-full sm:w-auto', styles.button)}
        >
          {isLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {confirmLabel ?? t('components:confirmModal.delete')}
        </button>
      </div>
    </ModalShell>
  )
}
