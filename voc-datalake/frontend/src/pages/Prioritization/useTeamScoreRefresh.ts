/**
 * @fileoverview Keeps the row's team score in step with its room vote.
 *
 * A room ballot is written into the same aggregate the team score is read from, but
 * the page only re-read that aggregate on its own save or a reload — so a facilitator
 * watched "3 ballots in" climb while the team score beside it stayed where it was. The
 * room-vote panel already polls the session while it is open; this re-reads the scores
 * whenever that poll reports a different ballot count, and once more when the vote
 * stops accepting ballots (closed here, closed elsewhere, or expired), so the final
 * number is on screen without a reload.
 *
 * @module pages/Prioritization/useTeamScoreRefresh
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { PRIORITIZATION_SCORES_KEY } from './prioritizationKeys'
import type { VotingSession } from '../../api/votingSessionsApi'

/** What about a session can change the team score: its ballots, and whether it still takes them. */
const signatureOf = (session: VotingSession | undefined): string | null => (
  session === undefined ? null : `${session.session_id}:${String(session.ballot_count)}:${session.state}`
)

export function useTeamScoreRefresh(session: VotingSession | undefined): void {
  const queryClient = useQueryClient()
  const signature = signatureOf(session)
  // The first reading of a session is not a change: the scores on screen were read
  // with it already in place, so re-reading them then would only cost a request.
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (signature === null) return
    const previous = seen.current
    seen.current = signature
    if (previous !== null && previous !== signature) {
      void queryClient.invalidateQueries({ queryKey: PRIORITIZATION_SCORES_KEY })
    }
  }, [signature, queryClient])
}
