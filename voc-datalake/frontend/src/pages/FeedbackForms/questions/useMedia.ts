/**
 * @fileoverview Whether a media query matches now, kept live (the Questions tab's three, two or one panes).
 * @module pages/FeedbackForms/questions/useMedia
 */
import { useCallback, useSyncExternalStore } from 'react'
import { noCleanup } from '../../../hooks/noCleanup'

const matches = (query: string): boolean => typeof window.matchMedia === 'function' && window.matchMedia(query).matches

export function useMedia(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window.matchMedia !== 'function') return noCleanup
    const list = window.matchMedia(query)
    list.addEventListener('change', notify)
    return () => list.removeEventListener('change', notify)
  }, [query])
  return useSyncExternalStore(subscribe, () => matches(query), () => false)
}

/** ≥ xl (1280 px): list, editor and preview side by side. */
export const WIDE = '(min-width: 1280px)'
/** ≥ lg (1024 px): list and editor; the preview is a panel over the editor. */
export const MEDIUM = '(min-width: 1024px)'
