/**
 * @fileoverview The widest a Dashboard category axis may grow for the current
 * viewport: a third of a phone-width card below Tailwind's `sm` breakpoint,
 * more room from `sm` up so long source names ("Acme airlines main") are not
 * cut on a desktop card that has the space.
 * @module pages/Dashboard/useCategoryAxisMax
 */
import { useSyncExternalStore } from 'react'
import { MAX_CATEGORY_AXIS_PX } from './axisLabel'

/** Tailwind's `sm` breakpoint. */
const WIDE_QUERY = '(min-width: 640px)'
const WIDE_MAX_PX = 200

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener('change', onChange)
  return () => { query.removeEventListener('change', onChange) }
}

function isWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches
}

/** Server render / no matchMedia: assume the narrow layout (the safe, shorter cap). */
function isWideOnServer(): boolean {
  return false
}

export function useCategoryAxisMax(): number {
  const wide = useSyncExternalStore(subscribe, isWide, isWideOnServer)
  return wide ? WIDE_MAX_PX : MAX_CATEGORY_AXIS_PX
}
