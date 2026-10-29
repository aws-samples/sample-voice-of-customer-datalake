/**
 * @fileoverview Removable chips under the composer text (attachments, mentions): each an icon,
 * a one-line label (cut with an ellipsis, the full text in the tooltip) and an X button.
 *
 * @module assistant/components/RemovableChips
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface ChipItem {
  key: string
  icon: ReactNode
  label: string
  tooltip: string
  /** The X button's accessible name (and tooltip). */
  removeLabel: string
}

export default function RemovableChips({ items, tone, label, className, onRemove }: Readonly<{
  items: readonly ChipItem[]
  tone: 'muted' | 'accent'
  /** The list's accessible name, when it needs one. */
  label?: string
  className?: string
  onRemove: (key: string) => void
}>) {
  return (
    <ul className={`flex flex-wrap gap-1 ${className ?? ''}`} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={`badge badge-${tone}`}>
          {item.icon}
          <span className="max-w-[10rem] truncate" title={item.tooltip}>{item.label}</span>
          <button
            type="button" onClick={() => onRemove(item.key)} className="rounded-full transition-colors hover:text-text"
            aria-label={item.removeLabel} title={item.removeLabel}
          >
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}
