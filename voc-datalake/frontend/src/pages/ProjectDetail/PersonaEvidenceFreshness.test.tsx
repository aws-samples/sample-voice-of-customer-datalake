/**
 * @fileoverview A persona's evidence freshness in its header: how many new matching reviews since it was generated or
 * last refreshed, and Refresh evidence for an editor only, which adds them and asks the count again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import PersonaEvidenceFreshness from './PersonaEvidenceFreshness'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const FRESHNESS = '/projects/proj_1/personas/p1/evidence-freshness'
const REFRESH = '/projects/proj_1/personas/p1/evidence/refresh'

function serve(count: number, lowerBound = false) {
  const state = { count }
  routeFetchApi({
    [`GET ${FRESHNESS}`]: () => ({ persona_id: 'p1', since: '2026-11-18', count: state.count, count_is_lower_bound: lowerBound, refreshed_at: null, updates: 0 }),
    [`POST ${REFRESH}`]: () => {
      const added = state.count
      state.count = 0
      return { success: true, persona_id: 'p1', added, evidence_updates: [], evidence_refreshed_at: '2026-11-21T00:00:00Z' }
    },
  })
}

beforeEach(() => {
  resetFetchApi()
})

describe('PersonaEvidenceFreshness', () => {
  it('says how many new matching reviews arrived, and an editor refreshes the evidence', async () => {
    serve(3)
    const user = userEvent.setup()
    renderWithQueryClient(<PersonaEvidenceFreshness projectId="proj_1" personaId="p1" canEdit />)
    expect(await screen.findByText(/^3 new matching reviews since/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh evidence' }))
    expect(await screen.findByText('Added 3 reviews to its evidence')).toBeInTheDocument()
    expect(await screen.findByText(/^No new matching reviews since/)).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([path]) => path === REFRESH)).toHaveLength(1)
  })

  it('offers a viewer no refresh', async () => {
    serve(2)
    renderWithQueryClient(<PersonaEvidenceFreshness projectId="proj_1" personaId="p1" canEdit={false} />)
    expect(await screen.findByText(/^2 new matching reviews since/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh evidence' })).not.toBeInTheDocument()
  })

  it('says "at least" when the count was cut short', async () => {
    serve(40, true)
    renderWithQueryClient(<PersonaEvidenceFreshness projectId="proj_1" personaId="p1" canEdit />)
    expect(await screen.findByText(/^At least 40 new matching reviews since/)).toBeInTheDocument()
  })

  it('shows nothing when the count cannot be read', async () => {
    routeFetchApi({})
    const { container } = renderWithQueryClient(<PersonaEvidenceFreshness projectId="proj_1" personaId="p1" canEdit />)
    await vi.waitFor(() => expect(fetchApi).toHaveBeenCalledWith(FRESHNESS, undefined))
    expect(container).toBeEmptyDOMElement()
  })
})
