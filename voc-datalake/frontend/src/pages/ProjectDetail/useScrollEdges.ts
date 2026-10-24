/**
 * @fileoverview Whether a horizontally scrolling element has more content past
 * its left or right edge — so a narrow tab bar (390 px) can fade that edge and the
 * hidden tabs are discoverable. Re-measured on scroll and on resize.
 *
 * @module pages/ProjectDetail/useScrollEdges
 */
import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Sub-pixel scroll positions count as "at the edge". */
const EDGE_TOLERANCE_PX = 2

export interface ScrollEdges {
  readonly before: boolean
  readonly after: boolean
}

/** A ResizeObserver on `el`, or null where there is none to construct (old browsers, test doubles). */
function observeResize(el: HTMLElement, onResize: () => void): ResizeObserver | null {
  try {
    const observer = new ResizeObserver(onResize)
    observer.observe(el)
    return observer
  } catch {
    return null
  }
}

export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ before: false, after: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (el === null) return
    const before = el.scrollLeft > EDGE_TOLERANCE_PX
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_TOLERANCE_PX
    setEdges((current) => (current.before === before && current.after === after ? current : { before, after }))
  }, [ref])
  useEffect(() => {
    const el = ref.current
    if (el === null) return undefined
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const observer = observeResize(el, measure)
    return () => {
      el.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [ref, measure])
  return edges
}
