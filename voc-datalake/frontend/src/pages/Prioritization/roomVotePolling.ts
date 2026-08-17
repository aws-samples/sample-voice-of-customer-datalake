/**
 * @fileoverview When a room vote's ballot count is read again.
 *
 * Its own module for two reasons. It is a RULE rather than rendering, so it can be
 * stated and tested without a clock — driving it through the panel would mean
 * asserting on TanStack's scheduler, and fake timers installed after a query has
 * mounted observe nothing at all, which makes "polling stopped" true of every
 * implementation including one that never stops. And ESLint's fast-refresh rule
 * (rightly) refuses a non-component export from a component file.
 *
 * @module pages/Prioritization/roomVotePolling
 */
import type { VotingSession } from '../../api/votingSessionsApi'

/**
 * How often the ballot count is re-read while a session is open.
 *
 * Frequent enough that a facilitator can see the room voting — which is the whole
 * reason the count is on screen, it is how they know when to stop waiting — and
 * slow enough that a session left on a projector for an hour costs a few hundred
 * cheap reads rather than thousands.
 */
export const BALLOT_COUNT_POLL_MS = 5000

/**
 * The next read delay, or `false` to stop.
 *
 * `state` and not `status` is the whole rule. A session that ran out its clock is
 * stored as `status: 'open'` until DynamoDB's TTL sweeper reaches it, up to about
 * 48 hours later, so a poll keyed on `status` never stops for the ordinary end of
 * a vote — the one where nobody pressed Close.
 */
export function ballotCountRefetchInterval(session: VotingSession | undefined): number | false {
  return session?.state === 'open' ? BALLOT_COUNT_POLL_MS : false
}
