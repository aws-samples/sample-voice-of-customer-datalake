/**
 * @fileoverview The react-router half of the unsaved-changes guard: holds a
 * `useBlocker` and reports a blocked navigation to the guard. Mounted by
 * `useUnsavedChangesGuard` only inside a data router, so the hook itself never
 * calls `useBlocker` conditionally.
 *
 * @module components/UnsavedChangesGuard/RouterBlocker
 */
import { useEffect, useRef } from 'react'
import { useBlocker, useLocation, useNavigate } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { ignoreRejection } from '../../lib/rejections'

/**
 * A held navigation: go on, or stay. A held route change also says where from and to,
 * and can be tried again later (`retry`) after its blocker was reset.
 */
export interface PendingLeave {
  readonly proceed: () => void
  readonly stay: () => void
  readonly route?: { readonly current: Location; readonly next: Location; readonly retry: () => void }
}

export default function RouterBlocker({ when, onBlocked }: Readonly<{
  when: (current: Location, next: Location) => boolean
  onBlocked: (pending: PendingLeave) => void
}>) {
  // Read when the block happens; a location change alone never re-reports it.
  const location = useLocation()
  const current = useRef(location)
  useEffect(() => { current.current = location })
  const navigate = useNavigate()
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when(currentLocation, nextLocation))
  // `blocker` is the router state's own object: a new one only when the block
  // changes, so each block is reported once (a re-render does not re-open it).
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const next = blocker.location
    const retry = () => { Promise.resolve(navigate({ pathname: next.pathname, search: next.search, hash: next.hash })).catch(ignoreRejection) }
    onBlocked({ proceed: blocker.proceed, stay: blocker.reset, route: { current: current.current, next, retry } })
  }, [blocker, onBlocked, navigate])
  return null
}
