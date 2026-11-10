/**
 * @fileoverview Every mounted unsaved-changes guard, so a control that is not a
 * router navigation (a page's local-state tabs, e.g. Company or Admin) can ask
 * "is anything on screen dirty?" and route its action through that editor's
 * Save / Discard / Cancel dialog — without the page knowing which section holds
 * the edits.
 *
 * It also chains a held route change through EVERY dirty editor: react-router keeps
 * one blocker per router, so when two editors on one page hold edits, the one whose
 * blocker caught the navigation asks first and KEEPS holding it (its blocker stays
 * mounted) while the others ask in turn, each once (`runGuarded` with `answered`, `stay`); the held
 * navigation itself then proceeds, a Back or a replace included, or is reset on Cancel.
 *
 * @module components/UnsavedChangesGuard/guardRegistry
 */
import { useCallback } from 'react'
import type { Location } from 'react-router-dom'

export interface RegisteredGuard {
  /** Whether this editor holds unsaved edits right now. */
  readonly isDirty: () => boolean
  /** Open this editor's dialog; `action` runs after Save (success) or Discard, `stay` after Cancel. */
  readonly requestLeave: (action: () => void, stay?: () => void) => void
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
  /** The guards that already answered (one may still read dirty: no `onDiscard`, or not re-rendered yet). */
  readonly answered?: ReadonlySet<RegisteredGuard>
  /** A held route change: only editors that would block it ask. */
  readonly route?: { readonly current: Location; readonly next: Location }
  /** What Cancel in a later editor's dialog does (a held route change resets its blocker). */
  readonly stay?: () => void
}

function asks(guard: RegisteredGuard, { answered, route }: RunGuardedOptions): boolean {
  if (answered?.has(guard) === true || !guard.isDirty()) return false
  return route === undefined || guard.blocksRoute === undefined || guard.blocksRoute(route.current, route.next)
}

/** Whether some dirty editor (other than the `answered` ones) would ask before `route`. */
export function anyGuardAsks(options: RunGuardedOptions): boolean {
  return [...guards].some((guard) => asks(guard, options))
}

/** Run `action` now, or after every dirty editor's dialog, one after another, lets it through (each asks once). */
export function runGuarded(action: () => void, options: RunGuardedOptions = {}): void {
  const dirty = [...guards].find((guard) => asks(guard, options))
  if (dirty === undefined) action()
  else {
    const answered = new Set(options.answered).add(dirty)
    dirty.requestLeave(() => runGuarded(action, { ...options, answered }), options.stay)
  }
}

/** `runGuarded` as a stable callback, for local-state navigation (tabs, closes). */
export function useGuardedAction(): (action: () => void) => void {
  return useCallback((action: () => void) => runGuarded(action), [])
}

/*
 * The ONE route blocker. react-router supports a single `useBlocker` per router (a second one
 * logs "A router only supports one blocker at a time" and the last registered wins), and every
 * guard's `blockWhen` already asks all the dirty editors (`anyGuardAsks`), so one is enough:
 * the first guard that needs a blocker owns it, and when it stops needing it, the next one
 * that still does takes over.
 */
const wanting = new Set<RegisteredGuard>()
const owner: { current: RegisteredGuard | null } = { current: null }
const ownerListeners = new Set<() => void>()

/**
 * Keep the owner while it still wants the blocker, else hand it to the next guard that does.
 * A handoff spans two React commits (the old owner unmounts its blocker, the new one mounts its
 * own), so for a moment no blocker is registered; a user-paced navigation never falls in it.
 */
function electOwner(): void {
  const next = owner.current !== null && wanting.has(owner.current) ? owner.current : ([...wanting][0] ?? null)
  if (next === owner.current) return
  owner.current = next
  ownerListeners.forEach((listener) => { listener() })
}

/** Say whether `guard` needs the route blocker now (dirty, a dialog open, or holding a change). */
export function wantBlocker(guard: RegisteredGuard, wants: boolean): void {
  if (wants) wanting.add(guard)
  else wanting.delete(guard)
  electOwner()
}

/** For `useSyncExternalStore`: who owns the blocker, and a subscription to changes. */
export function subscribeBlockerOwner(listener: () => void): () => void {
  ownerListeners.add(listener)
  return () => { ownerListeners.delete(listener) }
}

export function blockerOwner(): RegisteredGuard | null {
  return owner.current
}
