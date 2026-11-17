/**
 * @fileoverview The entries of a row's ⋯ menu (RowActionsMenu.tsx): an action, or a line between two groups; and the
 * entries as the menu shows them. Apart from the component, so its file exports components only (react-refresh).
 *
 * @module components/RowActionsMenu/rowMenuEntries
 */
import type { LucideIcon } from 'lucide-react'

/** One item of the menu. */
export interface RowMenuAction {
  readonly kind: 'action'
  readonly id: string
  readonly label: string
  readonly icon?: LucideIcon
  readonly onSelect: () => void
  /** A destructive action (Delete, Remove): the danger tone; put it last, after a separator. */
  readonly danger?: boolean
  /** Why it cannot act now, shown under its label; the item stays focusable (`aria-disabled`) and does nothing. */
  readonly reason?: string
}

/** A line between two groups of items. */
interface RowMenuSeparator {
  readonly kind: 'separator'
  readonly id: string
}

export type RowMenuEntry = RowMenuAction | RowMenuSeparator

/** The entries as shown: no separator first, last or twice in a row (a group left empty by the caller's conditions). */
export function tidyEntries(entries: readonly RowMenuEntry[]): RowMenuEntry[] {
  const kept = entries.filter((entry, index) => entry.kind === 'action' || entries[index + 1]?.kind === 'action')
  const start = kept.findIndex((entry) => entry.kind === 'action')
  if (start === -1) return []
  return kept.slice(start).filter((entry, index, list) => entry.kind === 'action' || list[index - 1]?.kind === 'action')
}
