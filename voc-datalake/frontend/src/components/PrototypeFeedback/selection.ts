/**
 * @fileoverview The feedback view's selection rules (docs/prototype-builder.md Part 3):
 * nothing selected by default, a flagged item never selectable, and at most
 * {@link MAX_SELECTED_PINS} pins in one selection, an item counting each pin it folds.
 * @module components/PrototypeFeedback/selection
 */
import type { FeedbackGroup as Group, FeedbackItem as Item } from '../../api/prototypeFeedbackSchema'

/** Mirrors MAX_BATCH_PINS in lambda/shared/prototype_pins.py: the pins one incorporation may carry. */
export const MAX_SELECTED_PINS = 50

/** Why an item's checkbox is off, or null when it may be ticked (or is ticked). */
export type BlockedReason = 'flagged' | 'cap' | null

export function selectedPinCount(items: readonly Item[], selected: ReadonlySet<string>): number {
  return items.reduce((total, item) => (selected.has(item.item_id) ? total + item.count : total), 0)
}

export function blockedReason(item: Item, selected: ReadonlySet<string>, pinTotal: number): BlockedReason {
  if (item.flagged) return 'flagged'
  if (selected.has(item.item_id)) return null
  return pinTotal + item.count > MAX_SELECTED_PINS ? 'cap' : null
}

/** The group's items that could be ticked at all (not flagged, not over the cap on their own). */
function selectableInGroup(group: Group): Item[] {
  return group.items.filter((item) => !item.flagged && item.count <= MAX_SELECTED_PINS)
}

/** Every selectable item of the group is already ticked (and there is at least one). */
export function groupFullySelected(group: Group, selected: ReadonlySet<string>): boolean {
  const selectable = selectableInGroup(group)
  return selectable.length > 0 && selectable.every((item) => selected.has(item.item_id))
}

/**
 * Ticks the group's items in their order, skipping flagged ones and any that would
 * pass the cap (a later, smaller item may still fit). The cap counts every item of
 * the view (the second argument), so what other groups already hold counts too.
 */
export function selectGroup(group: Group, allItems: readonly Item[], selected: ReadonlySet<string>): Set<string> {
  const start = { ids: new Set(selected), total: selectedPinCount(allItems, selected) }
  return selectableInGroup(group).reduce((acc, item) => {
    if (acc.ids.has(item.item_id) || acc.total + item.count > MAX_SELECTED_PINS) return acc
    acc.ids.add(item.item_id)
    return { ids: acc.ids, total: acc.total + item.count }
  }, start).ids
}

export function clearGroup(group: Group, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  for (const item of group.items) next.delete(item.item_id)
  return next
}

/** The pin ids of the selected items, in the view's order. */
export function selectedPinIds(items: readonly Item[], selected: ReadonlySet<string>): string[] {
  return items.flatMap((item) => (selected.has(item.item_id) ? item.pin_ids : []))
}
