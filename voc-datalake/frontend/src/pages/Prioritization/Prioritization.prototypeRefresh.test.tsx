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
import { render, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockGetFeedbackForms = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
  },
}))

vi.mock('../../api/client', () => ({
  api: {
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    patchPrioritizationScores: () => Promise.resolve({ success: true }),
    getFeedbackForms: () => mockGetFeedbackForms(),
    getFeedbackFormStats: () => Promise.resolve({ success: true, stats: null }),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'
import { REFRESH_LEAD_MS } from '../../components/prototypeLinkLifetime'

const HOUR_MS = 60 * 60_000
const PROTOTYPE_PATH = 'https://d111.cloudfront.net/prototypes/p1/proto-1.html'
const ROW_TITLE = 'Feature A PR/FAQ'

const signedUrl = (expiresAtMs: number, signature: string) =>
  `${PROTOTYPE_PATH}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`

const project = {
  project_id: 'p1', name: 'Project 1', status: 'active',
  created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 0, document_count: 2,
}

const prfaq = {
  document_id: 'doc_prfaq', document_type: 'prfaq', title: ROW_TITLE,
  content: '# Feature A', created_at: '2025-01-01',
}

const prototypeDoc = (prototypeUrl?: string) => ({
  document_id: 'proto-1',
  document_type: 'prototype',
  title: 'Feature A prototype',
  content: '',
  prototype_format: 'html',
  prototype_url: prototypeUrl,
  created_at: '2025-01-03',
})

const payload = (documents: unknown[]) => ({ project_id: 'p1', documents })

/**
 * Render the page and wait until the fan-out project read has landed — the
 * scheduling is derived from its documents, so nothing is armed before then.
 */
async function renderLoadedPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await waitFor(() => {
    expect(screen.getByText(ROW_TITLE)).toBeInTheDocument()
  })
  await waitFor(() => {
    expect(mockGetProject).toHaveBeenCalledTimes(1)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockGetProjects.mockResolvedValue({ projects: [project] })
  mockGetPrioritizationScores.mockResolvedValue({ scores: {} })
  mockGetFeedbackForms.mockResolvedValue({ forms: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('pre-expiry re-sign on the Prioritization page', () => {
  it('re-reads the projects before the prototype signature expires', async () => {
    mockGetProject.mockResolvedValue(payload([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))]))
    await renderLoadedPage()

    // Just past the scheduled moment: one hour of life minus the five-minute lead.
    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS + 1000)
    })

    await waitFor(() => {
      expect(mockGetProject).toHaveBeenCalledTimes(2)
    })
  })

  it('does not re-read before the lead time is reached', async () => {
    mockGetProject.mockResolvedValue(payload([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))]))
    await renderLoadedPage()

    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS - 60_000)
    })

    expect(mockGetProject).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing when the prototype URL carries no readable deadline', async () => {
    // An unsigned URL. There is no deadline to beat, and a timer here would refetch
    // every project on the page forever for no reason.
    mockGetProject.mockResolvedValue(payload([prfaq, prototypeDoc(PROTOTYPE_PATH)]))
    await renderLoadedPage()

    await act(async () => {
      vi.advanceTimersByTime(4 * HOUR_MS)
    })

    expect(mockGetProject).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing for a page whose projects have no prototype at all', async () => {
    mockGetProject.mockResolvedValue(payload([prfaq]))
    await renderLoadedPage()

    await act(async () => {
      vi.advanceTimersByTime(4 * HOUR_MS)
    })

    expect(mockGetProject).toHaveBeenCalledTimes(1)
  })

  /**
   * The cycle has to continue for as long as the page is open. If the timer did not
   * re-arm off the replacement URL, a prototype would survive exactly one renewal
   * and then lapse — which looks fine in a short test and fails after two hours on a
   * second monitor.
   */
  it('re-arms off the replacement URL so renewal repeats', async () => {
    mockGetProject
      .mockResolvedValueOnce(payload([prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))]))
      .mockResolvedValue(payload([prfaq, prototypeDoc(signedUrl(Date.now() + 3 * HOUR_MS, 'sig-2'))]))
    await renderLoadedPage()

    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS + 1000)
    })
    await waitFor(() => {
      expect(mockGetProject).toHaveBeenCalledTimes(2)
    })

    // Past the SECOND deadline's lead, which only exists if the timer was re-armed
    // from the replacement rather than fired once and forgotten.
    await act(async () => {
      vi.advanceTimersByTime(3 * HOUR_MS)
    })

    await waitFor(() => {
      expect(mockGetProject).toHaveBeenCalledTimes(3)
    })
  })
})
