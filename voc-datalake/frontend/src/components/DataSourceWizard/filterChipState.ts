/**
 * @fileoverview The wizard's filter chip colours and the list toggle every chip row uses.
 *
 * @module components/DataSourceWizard/filterChipState
 */

/** A selected filter chip (design-system rule 7: selected = accent-subtle; hover never reuses it). */
export const SELECTED_FILTER = 'bg-accent-subtle border-accent text-accent-text'
export const UNSELECTED_FILTER = 'bg-bg-elevated border-border'

/** `item` added to or removed from `items`; an add past `max` (when given) leaves the list as it is. */
export function toggleArrayItem(items: readonly string[], item: string, max?: number): string[] {
  if (items.includes(item)) return items.filter((other) => other !== item)
  return max !== undefined && items.length >= max ? [...items] : [...items, item]
}
