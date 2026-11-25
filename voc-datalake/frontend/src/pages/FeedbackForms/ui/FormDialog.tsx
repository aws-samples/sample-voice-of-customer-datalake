/**
 * @fileoverview The builder's larger dialogs (Improve with AI, Compare on a stale save, one response of the
 * Results, the Style panel below xl): a centred headed dialog (components/HeadedDialog, the markup of
 * `pages/Participants/AskDetailModal.tsx`) whose body scrolls inside 90% of the viewport's height.
 *
 * @module pages/FeedbackForms/ui/FormDialog
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import HeadedDialog from '../../../components/HeadedDialog/HeadedDialog'

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

export default function FormDialog({ isOpen, onClose, title, description, icon, children, footer }: FormDialogProps) {
  return (
    <HeadedDialog isOpen={isOpen} onClose={onClose} title={title} description={description} icon={icon}
      footer={footer} placement="center" panelClassName="w-full max-w-2xl max-h-[90vh]" bodyClassName="overflow-y-auto">
      {children}
    </HeadedDialog>
  )
}
