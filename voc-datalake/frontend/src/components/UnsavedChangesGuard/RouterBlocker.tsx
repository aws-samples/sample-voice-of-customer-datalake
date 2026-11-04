/**
 * @fileoverview The react-router half of the unsaved-changes guard: holds a
 * `useBlocker` and reports a blocked navigation to the guard. Mounted by
 * `useUnsavedChangesGuard` only inside a data router, so the hook itself never
 * calls `useBlocker` conditionally.
 *
 * @module components/UnsavedChangesGuard/RouterBlocker
 */
import { useEffect, useRef } from 'react'
import { useBlocker, useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'

/** A held navigation: go on, or stay. A held route change also says where from and to. */
export interface PendingLeave {
  readonly proceed: () => void
  readonly stay: () => void
  readonly route?: { readonly current: Location; readonly next: Location }
}

export default function RouterBlocker({ when, onBlocked }: Readonly<{
  when: (current: Location, next: Location) => boolean
  onBlocked: (pending: PendingLeave) => void
}>) {
  // Read when the block happens; a location change alone never re-reports it.
  const location = useLocation()
  const current = useRef(location)
  useEffect(() => { current.current = location })
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when(currentLocation, nextLocation))
  // `blocker` is the router state's own object: a new one only when the block
  // changes, so each block is reported once (a re-render does not re-open it).
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    onBlocked({ proceed: blocker.proceed, stay: blocker.reset, route: { current: current.current, next: blocker.location } })
  }, [blocker, onBlocked])
  return null
}
