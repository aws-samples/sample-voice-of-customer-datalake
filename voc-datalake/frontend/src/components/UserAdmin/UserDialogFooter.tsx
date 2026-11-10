/**
 * @fileoverview Footer of the create/edit user dialogs: Cancel plus the primary
 * action, whose icon gives way to a spinner while its mutation is pending.
 *
 * @module components/UserAdmin/UserDialogFooter
 */
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface UserDialogFooterProps {
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly confirmLabel: string
  /** Shown before the label when not pending. */
  readonly confirmIcon: ReactNode
  readonly isPending: boolean
  readonly disabled: boolean
}

export default function UserDialogFooter({
  onCancel, onConfirm, confirmLabel, confirmIcon, isPending, disabled,
}: UserDialogFooterProps) {
  const { t } = useTranslation('components')
  return (
    <div className="dialog-footer flex-col-reverse sm:flex-row sm:gap-3">
      <button onClick={onCancel} className="btn btn-secondary w-full sm:w-auto">
        {t('userAdmin.cancel')}
      </button>
      <button
        onClick={onConfirm}
        disabled={disabled}
        className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
      >
        {isPending ? <Loader2 size={16} className="animate-spin" /> : confirmIcon}
        {confirmLabel}
      </button>
    </div>
  )
}
