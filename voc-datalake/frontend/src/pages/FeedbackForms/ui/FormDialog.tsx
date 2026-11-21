/**
 * @fileoverview The builder's larger dialogs (Improve with AI, Compare on a stale save, one response of the
 * Results, the Style panel below xl): main's `ModalShell` as a centred dialog, the markup of `pages/Participants/AskDetailModal.tsx` — a
 * header with its icon, the title (the dialog's name), a line under it and the close button, a body that scrolls
 * inside 90% of the viewport's height, and the footer's controls.
 *
 * ModalShell owns the dialog semantics: `role="dialog"` + `aria-modal`, Escape and the backdrop closing it, focus
 * moved in on open, trapped, and returned to the element that opened it on close.
 *
 * @module pages/FeedbackForms/ui/FormDialog
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import ModalShell from '../../../components/ModalShell/ModalShell'
import DialogClose from '../../../components/DialogClose/DialogClose'

interface FormDialogProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** The dialog's heading, and its accessible name. */
  readonly title: string
  /** A line under the title (undefined: none). */
  readonly description: ReactNode
  readonly icon: LucideIcon
  /** The body, which scrolls. */
  readonly children: ReactNode
  /** The footer's controls, pinned under the body; none: no footer (the Style panel, which saves with the form). */
  readonly footer?: ReactNode
}

export default function FormDialog({ isOpen, onClose, title, description, icon: Icon, children, footer }: FormDialogProps) {
  const titleId = useId()
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Icon size={20} className="shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title break-words">{title}</h2>
            {description === undefined ? null : <p className="dialog-description break-words">{description}</p>}
          </div>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-5 overflow-y-auto">{children}</div>
      {footer === undefined ? null : <div className="dialog-footer flex-wrap justify-between">{footer}</div>}
    </ModalShell>
  )
}
