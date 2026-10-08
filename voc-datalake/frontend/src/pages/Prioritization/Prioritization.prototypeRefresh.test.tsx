/**
 * The Prioritization page re-signs its prototype links before they lapse.
 *
 * This page reads every project at once, and every prototype URL on it is a signed
 * credential minted by that read. Until the row offered "Open in new tab" the page
 * could get away with never refreshing: a stale URL only fed an iframe that had
 * already loaded. An anchor cannot get away with it — a click navigates
 * immediately, so a pitch parked on screen past the signature's ~1h life would 403
 * with nothing able to intervene.
 *
 * So these assert the scheduling itself, not the arithmetic: `refreshDelayMs` and
 * `earliestPrototypeExpiry` are covered as pure functions, and deleting the hook
 * call from this page keeps every other test on it green. The interesting cases are
 * that a timer is set, that it re-reads the projects, and that it is NOT set when
 * there is no deadline to beat — a timer firing against nothing is a refetch loop
 * with extra steps.
 *
 * Fake timers are confined to this file and torn down in `afterEach`, because they
 * have leaked across files in this suite before (see the note in
 * useProjectData.test.ts). The affordance's own behaviour needs no timers and lives
 * in Prioritization.prototypeLink.test.tsx for that reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import './prioritization-mock-fixtures'
import {
  prioritizationMocks, HOUR_MS, PROTOTYPE_PATH, ROW_TITLE, signedUrl, project, prfaq, row, prototypeDoc,
} from './prioritization-fixtures'
import { renderUntilRow } from './prioritization-render-fixtures'
import { REFRESH_LEAD_MS } from '../../components/prototypeLinkLifetime'

const payload = (documents: unknown[]) => ({ project_id: 'p1', documents })

/**
 * Render the page and wait until the fan-out project read has landed — the
 * scheduling is derived from its documents, so nothing is armed before then.
 */
async function renderLoadedPage() {
  await renderUntilRow(ROW_TITLE)
  await waitFor(() => {
    expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(1)
  })
}

/** Stub the project read with `documents`, render until it has landed, then advance the clock by `ms`. */
async function loadThenAdvance(documents: unknown[], ms: number) {
  prioritizationMocks.getProject.mockResolvedValue(payload(documents))
  await renderLoadedPage()
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

// Hoisted by vitest, so placed with the hooks that stub the page they mock.

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  prioritizationMocks.getProjects.mockResolvedValue({ projects: [project] })
  prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, rows: { [row.row_id]: row } })
  prioritizationMocks.createPrioritizationRow.mockResolvedValue({ success: true, created: false, row })
  prioritizationMocks.getFeedbackForms.mockResolvedValue({ forms: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('pre-expiry re-sign on the Prioritization page', () => {
  it('re-reads the projects before the prototype signature expires', async () => {
    // Just past the scheduled moment: one hour of life minus the five-minute lead.
    await loadThenAdvance([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))], HOUR_MS - REFRESH_LEAD_MS + 1000)

    await waitFor(() => {
      expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(2)
    })
  })

  it('does not re-read before the lead time is reached', async () => {
    await loadThenAdvance([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))], HOUR_MS - REFRESH_LEAD_MS - 60_000)

    expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing when the prototype URL carries no readable deadline', async () => {
    // An unsigned URL. There is no deadline to beat, and a timer here would refetch
    // every project on the page forever for no reason.
    await loadThenAdvance([prfaq, prototypeDoc(PROTOTYPE_PATH)], 4 * HOUR_MS)

    expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing for a page whose projects have no prototype at all', async () => {
    await loadThenAdvance([prfaq], 4 * HOUR_MS)

    expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(1)
  })

  /**
   * The cycle has to continue for as long as the page is open. If the timer did not
   * re-arm off the replacement URL, a prototype would survive exactly one renewal
   * and then lapse — which looks fine in a short test and fails after two hours on a
   * second monitor.
   */
  it('re-arms off the replacement URL so renewal repeats', async () => {
    prioritizationMocks.getProject
      .mockResolvedValueOnce(payload([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))]))
      .mockResolvedValue(payload([prfaq, prototypeDoc(signedUrl(Date.now() + 3 * HOUR_MS, 'sig-2'))]))
    await renderLoadedPage()

    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS + 1000)
    })
    await waitFor(() => {
      expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(2)
    })

    // Past the SECOND deadline's lead, which only exists if the timer was re-armed
    // from the replacement rather than fired once and forgotten.
    await act(async () => {
      vi.advanceTimersByTime(3 * HOUR_MS)
    })

    await waitFor(() => {
      expect(prioritizationMocks.getProject).toHaveBeenCalledTimes(3)
    })
  })
})
