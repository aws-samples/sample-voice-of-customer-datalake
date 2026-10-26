/**
 * @fileoverview The state of one row's room vote: which session the panel shows,
 * and the open / close / start-over actions on it.
 *
 * The session shown is either the one this panel OPENED or the one it FOUND on
 * mount (`GET /voting-sessions?row_id=`). Finding it is what makes a reload safe:
 * before, a reloaded page offered "Open a room vote" while the vote it had opened
 * kept accepting ballots at its public link, and nothing on screen could close it.
 *
 * @module pages/Prioritization/useRoomVote
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ballotCountRefetchInterval } from './roomVotePolling'
import { votingSessionsApi } from '../../api/votingSessionsApi'
import type { VotingSession } from '../../api/votingSessionsApi'

/** The session the panel shows: the one it opened, else the one it found — unless
 *  the facilitator already dismissed that one with "Open another vote". */
function shownSessionId(
  openedId: string | null, foundId: string | null, dismissedId: string | null,
): string | null {
  if (openedId !== null) return openedId
  return foundId !== null && foundId !== dismissedId ? foundId : null
}

/** What the status query starts from: whichever answer already describes `id`. */
function seedFor(id: string | null, candidates: readonly (VotingSession | null | undefined)[]) {
  if (id === null) return undefined
  return candidates.find((candidate) => candidate?.session_id === id) ?? undefined
}

export function useRoomVote(rowId: string, rowTitle: string) {
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [dismissedId, setDismissedId] = useState<string | null>(null)

  // Read once per mount (the panel mounts when the row is expanded). Not polled:
  // a vote opened in another tab is not this panel's to chase, and opening one
  // here returns the running vote anyway (one open vote per row, server-side).
  const discovery = useQuery({
    queryKey: ['voting-session-open', rowId],
    queryFn: () => votingSessionsApi.findOpenVotingSession(rowId),
  })

  const openMutation = useMutation({
    mutationFn: () => votingSessionsApi.createVotingSession({ row_id: rowId, row_title: rowTitle }),
    onSuccess: (session) => setOpenedId(session.session_id),
  })

  const sessionId = shownSessionId(openedId, discovery.data?.session_id ?? null, dismissedId)

  // Polled while open so the facilitator can watch the room vote, and so a
  // session that has been closed (or has expired) stops claiming to be open.
  const { data: session } = useQuery({
    queryKey: ['voting-session', sessionId],
    queryFn: () => votingSessionsApi.getVotingSession(sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: (query) => ballotCountRefetchInterval(query.state.data),
    initialData: () => seedFor(sessionId, [openMutation.data, discovery.data]),
  })

  const closeMutation = useMutation({
    mutationFn: () => votingSessionsApi.closeVotingSession(sessionId ?? ''),
  })

  /**
   * Back to the un-opened state, so a second round can be run in the same
   * meeting — needed because a session ends in a way NOBODY CHOSE: it expires.
   *
   * Both mutations are reset as well as the id. `closeMutation.data` overrides the
   * poll by design (a close is authoritative the instant it returns), so leaving it
   * behind would make the next session read as closed the moment it opened; and a
   * stale `openMutation.data` would seed the query with the previous session. The
   * FOUND session is dismissed too, or it would come straight back.
   */
  const startOver = () => {
    setDismissedId(sessionId)
    setOpenedId(null)
    closeMutation.reset()
    openMutation.reset()
  }

  // The CLOSED reading wins whenever either side says so: the close mutation's own
  // response is authoritative the instant it returns. A stale "open" is the
  // dangerous direction — it is the state in which ballots are still accepted.
  const current = closeMutation.data ?? session

  return {
    sessionId,
    current: sessionId === null ? undefined : current,
    isChecking: discovery.isPending,
    openMutation,
    closeMutation,
    startOver,
  }
}
