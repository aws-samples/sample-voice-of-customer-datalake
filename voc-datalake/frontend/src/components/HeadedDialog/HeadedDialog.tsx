/**
 * @fileoverview The frame of a headed dialog on `ModalShell`: a header with an optional icon, the title (the dialog's
 * accessible name), a line under it and the close button; a body that scrolls; and the footer's controls, pinned
 * under it. Two placements share it: a centred dialog (pages/FeedbackForms/ui/FormDialog) and a side sheet at the
 * inline end (components/SideSheet).
 *
 * ModalShell owns the dialog semantics: `role="dialog"` + `aria-modal`, Escape and the backdrop closing it, focus
 * moved in on open, trapped, and returned to the element that opened it on close; a dialog opened from inside it
 * (a confirmation) stacks above it.
 *
 * @module components/HeadedDialog
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import ModalShell from '../ModalShell/ModalShell'
import DialogClose from '../DialogClose/DialogClose'

export interface HeadedDialogProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** The heading, and the dialog's accessible name. */
  readonly title: string
  /** A line under the title (whom or what the dialog is about); none: no line. */
  readonly description?: ReactNode
  readonly icon?: LucideIcon
  /** The body, which scrolls. */
  readonly children: ReactNode
  /** The footer's controls, pinned under the body (`dialog-footer`); none: no footer. */
  readonly footer?: ReactNode
  /** `center`: a dialog in the middle of the viewport; `end`: a full-height sheet at the inline end. */
  readonly placement: 'center' | 'end'
  /** Extra classes for the panel (its width and height). */
  readonly panelClassName?: string
  /** Extra classes for the body. */
  readonly bodyClassName?: string
  /** False while work is in flight (a save): Escape, the backdrop and the close button wait (ModalShell `dismissable`). */
  readonly dismissable?: boolean
}

export default function HeadedDialog({
  isOpen, onClose, title, description, icon: Icon, children, footer, placement, panelClassName, bodyClassName,
  dismissable = true,
}: HeadedDialogProps) {
  const titleId = useId()
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={titleId} placement={placement}
      panelClassName={panelClassName} dismissable={dismissable}>
      <div className="dialog-header justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {Icon === undefined ? null : <Icon size={20} className="shrink-0 text-accent" aria-hidden="true" />}
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title break-words">{title}</h2>
            {description === undefined ? null : <p className="dialog-description break-words">{description}</p>}
          </div>
        </div>
        <DialogClose onClick={onClose} disabled={!dismissable} />
      </div>
      <div className={clsx('dialog-body space-y-5', bodyClassName)}>{children}</div>
      {footer === undefined ? null : <div className="dialog-footer flex-wrap justify-between">{footer}</div>}
    </ModalShell>
  )
}
