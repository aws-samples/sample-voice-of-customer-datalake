/**
 * @fileoverview An icon-only row action of the Data Explorer lists (S3 objects, processed feedback):
 * the label is both the tooltip and the accessible name; an expand toggle passes its aria state.
 * @module pages/DataExplorer/RowAction
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'

export function RowAction({ icon: Icon, label, onClick, className, ...aria }: Readonly<{
  icon: LucideIcon
  label: string
  onClick: () => void
  className?: string
  'aria-expanded'?: boolean
  'aria-controls'?: string
}>) {
  return (
    <button type="button" onClick={onClick} className={clsx('icon-btn p-2', className)} title={label} aria-label={label} {...aria}>
      <Icon size={16} />
    </button>
  )
}
