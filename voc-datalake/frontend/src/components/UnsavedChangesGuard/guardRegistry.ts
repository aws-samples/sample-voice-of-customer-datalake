/**
 * @fileoverview Every mounted unsaved-changes guard, so a control that is not a
 * router navigation (a page's local-state tabs, e.g. Company or Admin) can ask
 * "is anything on screen dirty?" and route its action through that editor's
 * Save / Discard / Cancel dialog — without the page knowing which section holds
 * the edits.
 *
 * @module components/UnsavedChangesGuard/guardRegistry
 */
import { useCallback } from 'react'

export interface RegisteredGuard {
  /** Whether this editor holds unsaved edits right now. */
  readonly isDirty: () => boolean
  /** Open this editor's dialog; `action` runs after Save (success) or Discard. */
  readonly requestLeave: (action: () => void) => void
}

const guards = new Set<RegisteredGuard>()

export function registerGuard(guard: RegisteredGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

/** Run `action` now, or after the first dirty editor's dialog lets it through. */
export function runGuarded(action: () => void): void {
  const dirty = [...guards].find((guard) => guard.isDirty())
  if (dirty === undefined) action()
  else dirty.requestLeave(action)
}

/** `runGuarded` as a stable callback, for local-state navigation (tabs, closes). */
export function useGuardedAction(): (action: () => void) => void {
  return useCallback((action: () => void) => runGuarded(action), [])
}
