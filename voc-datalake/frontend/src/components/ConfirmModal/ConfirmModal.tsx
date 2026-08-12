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
import ModalShell from '../ModalShell'

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
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  variant = 'danger',
  isLoading = false,
  onConfirm,
  onCancel,
}: Readonly<ConfirmModalProps>) {
  if (!isOpen) return null

  const variantStyles = {
    danger: {
      icon: 'bg-red-100 text-red-600',
      button: 'bg-red-600 hover:bg-red-700 text-white',
    },
    warning: {
      icon: 'bg-amber-100 text-amber-600',
      button: 'bg-amber-600 hover:bg-amber-700 text-white',
    },
    info: {
      icon: 'bg-blue-100 text-blue-600',
      button: 'bg-blue-600 hover:bg-blue-700 text-white',
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
      
      {/* Modal */}
      <div className="p-4 sm:p-6">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className={clsx('w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center flex-shrink-0', styles.icon)}>
            <AlertTriangle size={18} className="sm:w-5 sm:h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm text-gray-600">{message}</p>
            {children != null ? <div className="mt-3">{children}</div> : null}
          </div>
        </div>
        
        <div className="mt-5 sm:mt-6 flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2.5 sm:py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 w-full sm:w-auto"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={clsx('px-4 py-2.5 sm:py-2 text-sm font-medium rounded-lg disabled:opacity-50 flex items-center justify-center gap-2 w-full sm:w-auto', styles.button)}
          >
            {isLoading && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
