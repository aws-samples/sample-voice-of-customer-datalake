/**
 * @fileoverview The react-router half of the unsaved-changes guard: holds a
 * `useBlocker` and reports a blocked navigation to the guard. Mounted by
 * `useUnsavedChangesGuard` only inside a data router, so the hook itself never
 * calls `useBlocker` conditionally.
 *
 * @module components/UnsavedChangesGuard/RouterBlocker
 */
import { useEffect } from 'react'
import { useBlocker } from 'react-router-dom'
import type { Location } from 'react-router-dom'

/** A held navigation: go on, or stay. */
export interface PendingLeave {
  readonly proceed: () => void
  readonly stay: () => void
}

export default function RouterBlocker({ when, onBlocked }: Readonly<{
  when: (current: Location, next: Location) => boolean
  onBlocked: (pending: PendingLeave) => void
}>) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when(currentLocation, nextLocation))
  // `blocker` is the router state's own object: a new one only when the block
  // changes, so each block is reported once (a re-render does not re-open it).
  useEffect(() => {
    if (blocker.state === 'blocked') onBlocked({ proceed: blocker.proceed, stay: blocker.reset })
  }, [blocker, onBlocked])
  return null
}
