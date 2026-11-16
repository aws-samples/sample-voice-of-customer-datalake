/**
 * @fileoverview The roving focus of the document page's toolbar (DocumentToolbar, a WAI-ARIA `toolbar`): one Tab stop
 * for the whole row (the item last used, else the first); ArrowLeft / ArrowRight move between the items (wrapping),
 * Home / End to the first and last. Keys inside an open menu of the row are the menu's.
 *
 * @module components/DocumentCanvas/actions/useRovingToolbar
 */
import { useCallback, useRef, useState } from 'react'
import { rovingIndex, TAB_KEYS } from '../../../utils/rovingIndex'
import type { KeyboardEvent } from 'react'

/** What each item of the row takes from the roving focus. */
export interface RovingItem {
  readonly 'data-toolbar-item': string
  readonly tabIndex: 0 | -1
  readonly onFocus: () => void
}

const ITEM_ATTRIBUTE = 'data-toolbar-item'

function itemsOf(toolbar: HTMLElement | null): HTMLElement[] {
  return [...(toolbar?.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`) ?? [])]
}

/** The row's roving focus over the items named `ids`, in their order (see the module's doc). */
export function useRovingToolbar(ids: readonly string[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const active = current !== null && ids.includes(current) ? current : ids[0]
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const { target } = event
    if (!(target instanceof Element) || target.closest('[role="menu"]') !== null) return
    const at = target.closest<HTMLElement>(`[${ITEM_ATTRIBUTE}]`)?.getAttribute(ITEM_ATTRIBUTE) ?? null
    const index = at === null ? -1 : ids.indexOf(at)
    if (index < 0) return
    const next = rovingIndex(event.key, index, ids.length, TAB_KEYS)
    const id = next === null ? undefined : ids[next]
    if (id === undefined) return
    event.preventDefault()
    setCurrent(id)
    itemsOf(ref.current).find((item) => item.getAttribute(ITEM_ATTRIBUTE) === id)?.focus()
  }, [ids])
  const rove = useCallback((id: string): RovingItem => ({
    [ITEM_ATTRIBUTE]: id, tabIndex: id === active ? 0 : -1, onFocus: () => setCurrent(id),
  }), [active])
  return { ref, onKeyDown, rove }
}
