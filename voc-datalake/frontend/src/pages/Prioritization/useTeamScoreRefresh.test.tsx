/**
 * The team score beside a room vote follows the vote: a new ballot, or the vote
 * ending, re-reads the prioritization scores without a page reload (5.34 e2e).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTeamScoreRefresh } from './useTeamScoreRefresh'
import { PRIORITIZATION_SCORES_KEY } from './prioritizationKeys'
import type { VotingSession } from '../../api/votingSessionsApi'
import type { ReactNode } from 'react'

function session(overrides: Partial<VotingSession> = {}): VotingSession {
  return {
    session_id: 'vs_1', row_id: 'row_1', row_title: 'Instant refunds',
    status: 'open', state: 'open', ballot_cap: 40, ballot_count: 0, ...overrides,
  }
}

function harness(initial: VotingSession | undefined) {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(({ current }: { current: VotingSession | undefined }) => {
    useTeamScoreRefresh(current)
  }, { wrapper, initialProps: { current: initial } })
  return { invalidate, rerender: (current: VotingSession | undefined) => { hook.rerender({ current }) } }
}

const scoresReRead = { queryKey: PRIORITIZATION_SCORES_KEY }

describe('the team score beside a room vote', () => {
  it('is re-read when the poll reports a new ballot', () => {
    const { invalidate, rerender } = harness(session({ ballot_count: 0 }))
    expect(invalidate).not.toHaveBeenCalled()

    rerender(session({ ballot_count: 1 }))

    expect(invalidate).toHaveBeenCalledWith(scoresReRead)
  })

  it('is re-read once more when the vote is closed', () => {
    const { invalidate, rerender } = harness(session({ ballot_count: 2 }))

    rerender(session({ ballot_count: 2, status: 'closed', state: 'closed' }))

    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('is not re-read by a poll that brings nothing new', () => {
    const { invalidate, rerender } = harness(session({ ballot_count: 3 }))

    rerender(session({ ballot_count: 3 }))

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('is not re-read before any session is shown', () => {
    const { invalidate, rerender } = harness(undefined)

    rerender(session())

    expect(invalidate).not.toHaveBeenCalled()
  })
})
