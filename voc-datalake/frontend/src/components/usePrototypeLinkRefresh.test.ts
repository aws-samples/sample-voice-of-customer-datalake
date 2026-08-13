/**
 * A scheduled re-sign belongs to the scope it was armed for.
 *
 * `useProjectData.prototypeRefresh.test.tsx` covers that the timer fires, invalidates
 * and re-arms off the replacement URL. It cannot cover this, because it renders one
 * project: the hole is what happens when the SCOPE changes underneath a pending timer
 * and the deadline does not.
 *
 * That combination is reachable. `Expires` is whole seconds and every signature in a
 * response is minted from one clock, so two projects can easily carry the same
 * earliest deadline — and if the deadline is the effect's only dependency, navigating
 * between them leaves the first project's timer running against the second. Keying
 * the effect on the scope as well is what makes it unreachable, and this file is what
 * fails if that key is removed.
 *
 * The deadline below sits INSIDE the refresh lead deliberately, so `refreshDelayMs`
 * returns its floor. That is the only regime where re-arming is observable at all:
 * with a distant deadline the delay is recomputed from the same fixed moment, so a
 * re-armed timer fires when the inherited one would have and the two are
 * indistinguishable. With the floor, re-arming restarts the 30s clock — so a refresh
 * arriving at the inherited moment is proof the timer was inherited.
 *
 * Fake timers are confined to this file and torn down in `afterEach`; they have leaked
 * across files in this suite before.
 */
import { renderHook } from '@testing-library/react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { MIN_REFRESH_DELAY_MS, REFRESH_LEAD_MS } from './prototypeLinkLifetime'
import { usePrototypeLinkRefresh } from './usePrototypeLinkRefresh'
import type { ProjectDocument } from '../api/types'

const BASE_MS = new Date('2026-01-01T12:00:00Z').getTime()

/**
 * A deadline near enough that `refreshDelayMs` floors the delay — see the file note.
 * Ten seconds inside the lead, so the raw figure (10s) loses to the 30s floor.
 */
const EXPIRES_AT_MS = BASE_MS + REFRESH_LEAD_MS + 10_000

/**
 * How far into the pending timer the navigation happens. Two thirds of the way, so an
 * inherited timer still has time left to run and a re-armed one is not yet due either
 * — neither outcome is an artifact of the navigation landing on the deadline itself.
 */
const NAVIGATE_AFTER_MS = 20_000

const prototypeDoc = (expiresAtMs: number): ProjectDocument => ({
  document_id: 'doc-1',
  title: 'My Prototype',
  content: '',
  document_type: 'prototype',
  prototype_format: 'html',
  prototype_url:
    `https://d1.cloudfront.net/prototypes/doc-1.html?Expires=${expiresAtMs / 1000}&Signature=s&Key-Pair-Id=K1`,
  created_at: '2026-01-01T00:00:00Z',
})

/**
 * Arm a refresh for one scope, then navigate to another whose deadline is identical.
 *
 * Returns the spy and a way to move the clock. The documents are the same value for
 * both scopes on purpose: an equal deadline is the whole premise.
 */
function arrangeNavigation() {
  const onRefresh = vi.fn()
  const documents = [prototypeDoc(EXPIRES_AT_MS)]
  const { rerender } = renderHook(
    ({ scope }: { scope: string }) => usePrototypeLinkRefresh(documents, onRefresh, scope),
    { initialProps: { scope: 'proj-a' } },
  )

  vi.advanceTimersByTime(NAVIGATE_AFTER_MS)
  expect(onRefresh).not.toHaveBeenCalled()

  rerender({ scope: 'proj-b' })
  return onRefresh
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_MS)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('prototype refresh scheduling across a scope change', () => {
  it('does not fire a refresh armed for the project it navigated away from', () => {
    const onRefresh = arrangeNavigation()

    // Past the moment the first scope's timer was due. A refresh arriving here means
    // that timer survived the navigation — the state this hook must make unreachable.
    vi.advanceTimersByTime(MIN_REFRESH_DELAY_MS - NAVIGATE_AFTER_MS + 5_000)

    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('arms a fresh refresh for the project it navigated to', () => {
    const onRefresh = arrangeNavigation()

    // The floor restarts from the navigation, so the replacement is due 30s after it.
    vi.advanceTimersByTime(MIN_REFRESH_DELAY_MS + 1_000)

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
