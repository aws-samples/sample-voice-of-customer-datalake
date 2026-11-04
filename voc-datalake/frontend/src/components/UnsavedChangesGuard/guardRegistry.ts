/**
 * @fileoverview Every mounted unsaved-changes guard, so a control that is not a
 * router navigation (a page's local-state tabs, e.g. Company or Admin) can ask
 * "is anything on screen dirty?" and route its action through that editor's
 * Save / Discard / Cancel dialog — without the page knowing which section holds
 * the edits.
 *
 * It also chains a held route change through EVERY dirty editor: react-router keeps
 * one blocker per router, so when two editors on one page hold edits, the one whose
 * blocker caught the navigation asks first, releases it, and the others ask in turn
 * (`runGuarded` with `except`); once all have let it go, the navigation is retried.
 *
 * @module components/UnsavedChangesGuard/guardRegistry
 */
import { useCallback } from 'react'
import type { Location } from 'react-router-dom'

export interface RegisteredGuard {
  /** Whether this editor holds unsaved edits right now. */
  readonly isDirty: () => boolean
  /** Open this editor's dialog; `action` runs after Save (success) or Discard. */
  readonly requestLeave: (action: () => void) => void
  /** Whether this editor would hold a route change from `current` to `next` (its `shouldBlock`). */
  readonly blocksRoute?: (current: Location, next: Location) => boolean
}

const guards = new Set<RegisteredGuard>()

export function registerGuard(guard: RegisteredGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

interface RunGuardedOptions {
  /** The guard that already asked (it may still read dirty until it re-renders). */
  readonly except?: RegisteredGuard
  /** A held route change: only editors that would block it ask. */
  readonly route?: { readonly current: Location; readonly next: Location }
}

function asks(guard: RegisteredGuard, { except, route }: RunGuardedOptions): boolean {
  if (guard === except || !guard.isDirty()) return false
  return route === undefined || guard.blocksRoute === undefined || guard.blocksRoute(route.current, route.next)
}

/** Whether some dirty editor (other than `except`) would ask before `route`. */
export function anyGuardAsks(options: RunGuardedOptions): boolean {
  return [...guards].some((guard) => asks(guard, options))
}

/** Run `action` now, or after every dirty editor's dialog, one after another, lets it through. */
export function runGuarded(action: () => void, options: RunGuardedOptions = {}): void {
  const dirty = [...guards].find((guard) => asks(guard, options))
  if (dirty === undefined) action()
  else dirty.requestLeave(() => runGuarded(action, { ...options, except: dirty }))
}

/** The route change every dirty editor has let through, while its one retry runs. */
const released: { key: string | null } = { key: null }

const routeKey = (location: Pick<Location, 'pathname' | 'search' | 'hash'>): string =>
  `${location.pathname}${location.search}${location.hash}`

/**
 * Run `retry` (a navigation to `next`) with that one change let through every blocker.
 * react-router asks its blocker synchronously when `navigate` starts, so the release
 * ends as soon as `retry` returns: no later navigation to the same place is ever let
 * through unasked.
 */
export function retryReleased(next: Location, retry: () => void): void {
  released.key = routeKey(next)
  try {
    retry()
  } finally {
    released.key = null
  }
}

/** True while the retry of the released change `next` is being decided; a blocker then lets it through. */
export function isReleased(next: Location): boolean {
  return released.key !== null && released.key === routeKey(next)
}

/** `runGuarded` as a stable callback, for local-state navigation (tabs, closes). */
export function useGuardedAction(): (action: () => void) => void {
  return useCallback((action: () => void) => runGuarded(action), [])
}
