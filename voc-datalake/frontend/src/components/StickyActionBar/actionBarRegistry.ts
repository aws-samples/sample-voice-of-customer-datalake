/**
 * @fileoverview Keep-clear zones: the parts of a page the floating assistant launcher must never cover.
 *
 * A zone registers its element while mounted (`useRegisterKeepClear(ref, { mode })`) and says how the launcher
 * keeps clear of it (assistant/bubble/geometry `keepClear`):
 *
 * - `lift`: a page's sticky primary-action bar (Save / Discard / Submit …, `StickyActionBar`): the launcher rises
 *   above it. `useRegisterActionBar` is this mode.
 * - `beside`: a tall pane at the page's end edge (a form's live preview, whose Next sits where the launcher rests):
 *   the launcher moves to the zone's inline-start side, at the same height (7.55.01, forms audit F4).
 *
 * The launcher reads the zones' on-screen boxes with `useKeepClearZones`. Boxes are re-measured on registration,
 * resize, any scroll (capture, so the layout's inner scroll container counts) and when a zone or its parent changes
 * size (the parent too: a zone of fixed width moves when the column beside it grows or shrinks), coalesced to one
 * measurement per animation frame.
 *
 * @module components/StickyActionBar/actionBarRegistry
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** A box on screen, as `getBoundingClientRect` reports it. */
export interface BarRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/** How the launcher keeps clear of a zone: rise above it (`lift`), or stand at its inline-start side (`beside`). */
export type KeepClearMode = 'lift' | 'beside'

/** A registered zone's current box and mode. */
export interface KeepClearZone extends BarRect {
  readonly mode: KeepClearMode
}

const zones = new Map<HTMLElement, KeepClearMode>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Register `ref`'s element as a keep-clear zone for as long as it is mounted. Checked after every render, so a zone
 * the component renders conditionally (a preview shown from one breakpoint, a panel opened on demand) registers
 * when it appears and leaves when it goes; a render that changes neither the element nor the mode costs one lookup.
 */
export function useRegisterKeepClear(ref: RefObject<HTMLElement | null>, { mode }: { readonly mode: KeepClearMode }): void {
  const registered = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const element = ref.current
    const previous = registered.current
    if (element === previous && (element === null || zones.get(element) === mode)) return
    if (previous !== null) zones.delete(previous)
    if (element !== null) zones.set(element, mode)
    registered.current = element
    notify()
  })
  useEffect(() => () => {
    const element = registered.current
    if (element === null) return
    zones.delete(element)
    registered.current = null
    notify()
  }, [])
}

const LIFT = { mode: 'lift' } as const

/** Register `ref`'s element as a page's bottom action bar: the launcher lifts above it. */
export function useRegisterActionBar(ref: RefObject<HTMLElement | null>): void {
  useRegisterKeepClear(ref, LIFT)
}

/** The registered zones' current boxes (non-empty ones only: a zone hidden with `display: none` keeps nothing clear). */
function measureZones(): KeepClearZone[] {
  return [...zones]
    .map(([element, mode]) => ({ rect: element.getBoundingClientRect(), mode }))
    .filter(({ rect }) => rect.height > 0 && rect.width > 0)
    .map(({ rect: { top, bottom, left, right }, mode }) => ({ top, bottom, left, right, mode }))
}

const sameZones = (a: readonly KeepClearZone[], b: readonly KeepClearZone[]): boolean =>
  a.length === b.length && a.every((r, i) => {
    const other = b[i]
    return r.mode === other?.mode && r.top === other.top && r.bottom === other.bottom && r.left === other.left && r.right === other.right
  })

/** Live boxes of every registered keep-clear zone. */
export function useKeepClearZones(): KeepClearZone[] {
  const [rects, setRects] = useState<KeepClearZone[]>(measureZones)
  useEffect(() => {
    const pending: { frame: number | null } = { frame: null }
    const measure = () => {
      pending.frame = null
      const next = measureZones()
      setRects((previous) => (sameZones(previous, next) ? previous : next))
    }
    const schedule = () => {
      pending.frame ??= requestAnimationFrame(measure)
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    const observeAll = () => {
      resizeObserver?.disconnect()
      for (const zone of zones.keys()) {
        resizeObserver?.observe(zone)
        if (zone.parentElement !== null) resizeObserver?.observe(zone.parentElement)
      }
      schedule()
    }
    listeners.add(observeAll)
    observeAll()
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    return () => {
      listeners.delete(observeAll)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, { capture: true })
      if (pending.frame !== null) cancelAnimationFrame(pending.frame)
    }
  }, [])
  return rects
}
