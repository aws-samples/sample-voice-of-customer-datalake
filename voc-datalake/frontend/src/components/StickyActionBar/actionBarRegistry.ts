/**
 * @fileoverview The bottom safe area: the page's sticky primary-action bars.
 *
 * A bar registers its element while mounted (`useRegisterActionBar`); floating
 * UI that must never cover a page's primary actions — the assistant launcher —
 * reads the bars' on-screen boxes with `useActionBarRects` and keeps clear of
 * them. Boxes are re-measured on registration, resize, any scroll (capture, so
 * the layout's inner scroll container counts) and when a bar changes size,
 * coalesced to one measurement per animation frame.
 *
 * @module components/StickyActionBar/actionBarRegistry
 */
import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** A bar's on-screen box, as `getBoundingClientRect` reports it. */
export interface BarRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

const bars = new Set<HTMLElement>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Register `ref`'s element as a bottom action bar for as long as the caller is mounted. */
export function useRegisterActionBar(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    bars.add(element)
    notify()
    return () => {
      bars.delete(element)
      notify()
    }
  }, [ref])
}

/** The registered bars' current boxes (non-empty ones only). */
function measureActionBars(): BarRect[] {
  return [...bars]
    .map((bar) => bar.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.width > 0)
    .map(({ top, bottom, left, right }) => ({ top, bottom, left, right }))
}

const sameRects = (a: readonly BarRect[], b: readonly BarRect[]): boolean =>
  a.length === b.length && a.every((r, i) => {
    const other = b[i]
    return r.top === other?.top && r.bottom === other.bottom && r.left === other.left && r.right === other.right
  })

/** Live boxes of every registered action bar. */
export function useActionBarRects(): BarRect[] {
  const [rects, setRects] = useState<BarRect[]>(measureActionBars)
  useEffect(() => {
    const pending: { frame: number | null } = { frame: null }
    const measure = () => {
      pending.frame = null
      const next = measureActionBars()
      setRects((previous) => (sameRects(previous, next) ? previous : next))
    }
    const schedule = () => {
      pending.frame ??= requestAnimationFrame(measure)
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    const observeAll = () => {
      resizeObserver?.disconnect()
      for (const bar of bars) resizeObserver?.observe(bar)
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
