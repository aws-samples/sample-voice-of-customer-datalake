/**
 * @fileoverview A right-hand side sheet (KiroCrew's SideSheet, ported onto `ModalShell` with its
 * `end` placement): full height at the inline end, the viewport's width below `sm` and 30rem from it, sliding in from
 * the end (`--animate-slide-in-end`, 0.24 s on the house easing). It keeps the row that opened it in view beside it,
 * and its height is the viewport's whatever it holds: the header and footer stay put while the body scrolls.
 * `size="wide"` (44rem from `sm`) holds a document (the Documents Library's preview).
 *
 * The frame (header, scrolling body, footer) and the dialog semantics are components/HeadedDialog's, which the
 * centred dialogs share.
 *
 * @module components/SideSheet
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import HeadedDialog from '../HeadedDialog/HeadedDialog'

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
  /** `default` (30rem from `sm`: a row's editor) or `wide` (44rem: a document). */
  readonly size?: 'default' | 'wide'
  /** False while work is in flight (a save): Escape, the backdrop and the close button wait (ModalShell `dismissable`). */
  readonly dismissable?: boolean
}

/** The panel's width from `sm` per size (`.sheet-panel` holds the default). */
const SIZE_CLASS = { default: '', wide: 'sm:max-w-[44rem]' } as const

export default function SideSheet({ size = 'default', children, ...frame }: SideSheetProps) {
  return <HeadedDialog {...frame} placement="end" panelClassName={SIZE_CLASS[size]}>{children}</HeadedDialog>
}
