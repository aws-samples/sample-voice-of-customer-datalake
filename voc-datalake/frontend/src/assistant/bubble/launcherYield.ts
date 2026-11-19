/**
 * @fileoverview A page that offers the assistant in its own menu asks the floating launcher to step aside.
 *
 * (7.04.00, forms audit §4.2) Below `md` the form builder's ⋯ menu has "Ask the assistant": a 48 px bubble over a
 * one-column editor always covers one of its controls. The page calls `useYieldLauncher(true)` while it offers that
 * entry; AssistantRoot hides the launcher (not the panel) while any page yields, and shows it again as soon as none
 * does (the page unmounts, or the window grows past the breakpoint).
 *
 * @module assistant/bubble/launcherYield
 */
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { noCleanup } from '../../hooks/noCleanup'

const listeners = new Set<() => void>()
/** One token per mounted caller that yields now, so two of them never undo each other. */
const yielding = new Set<symbol>()

function announceYields(): void {
  listeners.forEach((listener) => { listener() })
}

/**
 * While `active`, the floating launcher is hidden. A layout effect: the launcher is gone before the page first
 * paints, never shown for a frame over it.
 */
export function useYieldLauncher(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return noCleanup
    const token = Symbol('launcher-yield')
    yielding.add(token)
    announceYields()
    return () => {
      yielding.delete(token)
      announceYields()
    }
  }, [active])
}

function listenToYields(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const anyYielding = (): boolean => yielding.size > 0

/** Does a page ask the launcher to step aside now? */
export function useLauncherYielded(): boolean {
  return useSyncExternalStore(listenToYields, anyYielding, anyYielding)
}
