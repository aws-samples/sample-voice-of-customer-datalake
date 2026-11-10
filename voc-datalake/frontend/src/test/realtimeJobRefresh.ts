/**
 * The shared checks of a view wired with `useRealtimeJobRefresh` (realtime/jobRefresh.ts, docs/realtime.md):
 * its own job notice re-reads it at once, another job's notice does not, and a (re)connect re-reads it.
 * Each check starts and ends with push off, so the poll fallback of other specs is untouched.
 */
import { waitFor } from '@testing-library/react'
import { expect, type Mock } from 'vitest'
import type { RealtimeNotice } from '../realtime/events'
import { deliverNotice, setRealtimeLive } from '../realtime/hub'

export interface JobNoticeRefreshCase {
  /** The read the view polls (a spy that already answers). */
  read: Mock
  /** Mount the view (a hook or a component). */
  mount: () => unknown
  /** A notice the view listens for, and one it must ignore. */
  notice: RealtimeNotice
  otherNotice: RealtimeNotice
}

async function mounted(view: JobNoticeRefreshCase): Promise<void> {
  setRealtimeLive(false)
  view.mount()
  await waitFor(() => { expect(view.read).toHaveBeenCalledTimes(1) })
}

/** Its own notice re-reads the view at once; another job's notice does not. */
export async function expectRereadOnItsNotice(view: JobNoticeRefreshCase): Promise<void> {
  await mounted(view)
  deliverNotice(view.otherNotice)
  deliverNotice(view.notice)
  await waitFor(() => { expect(view.read).toHaveBeenCalledTimes(2) })
}

/** A (re)connect re-reads the view: a notice may have been missed. */
export async function expectRereadOnReconnect(view: JobNoticeRefreshCase): Promise<void> {
  await mounted(view)
  setRealtimeLive(true)
  await waitFor(() => { expect(view.read).toHaveBeenCalledTimes(2) })
  setRealtimeLive(false)
}
