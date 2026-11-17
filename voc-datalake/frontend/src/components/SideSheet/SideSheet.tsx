/**
 * @fileoverview A right-hand side sheet (KiroCrew's SideSheet, ported onto `ModalShell` with its
 * `end` placement): full height at the inline end, the viewport's width below `sm` and 30rem from it, sliding in from
 * the end (`--animate-slide-in-end`, 0.24 s on the house easing). It keeps the row that opened it in view beside it,
 * and its height is the viewport's whatever it holds: the header and footer stay put while the body scrolls.
 *
 * ModalShell owns the dialog semantics: `role="dialog"` + `aria-modal`, the title as its name, Escape and the
 * backdrop closing it, focus moved in on open, trapped, and returned to the element
 * that opened it on close; a dialog opened from inside it (a confirmation) stacks above it.
 *
 * @module components/SideSheet
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import ModalShell from '../ModalShell/ModalShell'
import DialogClose from '../DialogClose/DialogClose'

interface SideSheetProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** The sheet's heading, and its accessible name. */
  readonly title: string
  /** A line under the title (whom or what the sheet edits). */
  readonly description?: ReactNode
  readonly icon?: LucideIcon
  /** The body, which scrolls. */
  readonly children: ReactNode
  /** The footer's controls, pinned under the body (`dialog-footer`); none: no footer. */
  readonly footer?: ReactNode
}

export default function SideSheet({ isOpen, onClose, title, description, icon: Icon, children, footer }: SideSheetProps) {
  const titleId = useId()
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={titleId} placement="end">
      <div className="dialog-header justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {Icon === undefined ? null : <Icon size={20} className="shrink-0 text-accent" aria-hidden="true" />}
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title">{title}</h2>
            {description === undefined ? null : <p className="dialog-description break-words">{description}</p>}
          </div>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-5">{children}</div>
      {footer === undefined ? null : <div className="dialog-footer flex-wrap justify-between">{footer}</div>}
    </ModalShell>
  )
}
