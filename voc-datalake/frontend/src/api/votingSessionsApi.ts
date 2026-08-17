/**
 * @fileoverview The voting-session API: opening a room's vote, and casting a
 * ballot in one.
 *
 * Its own module rather than more surface on `client.ts`, following the
 * `projectsApi` precedent — and for one reason specific to this feature: the two
 * PUBLIC calls cannot go through `fetchApi`. That helper throws
 * `API Error: <status>` and discards the response body, which is exactly the
 * information the ballot page exists to show: "this session is closed", "it has
 * expired", "the room is full". A phone that has just scanned a QR needs the
 * reason in words, so these two read the body and return it.
 *
 * The facilitator's three calls DO go through `fetchApi`, because they are
 * ordinary authenticated requests that want its 401 refresh-and-retry.
 *
 * Every response is parsed with a LENIENT zod schema at this boundary, per
 * project convention: a declared TypeScript type is a promise about the wire, not
 * a proof of it, and this page is reached by a phone against whatever version of
 * the API happens to be deployed.
 *
 * @module api/votingSessionsApi
 */
import { z } from 'zod'
import { getBaseUrl } from './baseUrl'
import { fetchApi } from './client'

/**
 * Why a ballot was refused. The strings are the backend's `reason` values
 * (`ballots_handler.py`), and the page maps each to its own translated sentence —
 * so a new reason arrives as `unknown` rather than as a blank screen.
 */
export const BALLOT_REFUSAL_REASONS = ['not_found', 'closed', 'expired', 'cap_reached'] as const

export type BallotRefusalReason = typeof BALLOT_REFUSAL_REASONS[number]

/** Anything else that stopped the submission — a network fault, a 500, a shape
 *  this client cannot read. Distinct from the four above because it is not a
 *  statement about the session, and the page says "try again" rather than
 *  explaining a state. */
export const BALLOT_REFUSAL_UNKNOWN = 'unknown'

export type BallotFailure = BallotRefusalReason | typeof BALLOT_REFUSAL_UNKNOWN

const refusalReason = z.enum(BALLOT_REFUSAL_REASONS)

/**
 * The facilitator's view of a session.
 *
 * Lenient on purpose: `.catch()` on every field means a response missing one
 * yields a session that reads as closed and empty rather than throwing inside a
 * query and taking a panel down. `status` is narrowed to the two states the
 * backend writes, defaulting to `closed` — the safe reading of a value this
 * client does not recognise.
 */
const votingSessionSchema = z.object({
  session_id: z.string().catch(''),
  document_id: z.string().catch(''),
  document_title: z.string().catch(''),
  status: z.enum(['open', 'closed']).catch('closed'),
  ballot_cap: z.number().catch(0),
  ballot_count: z.number().catch(0),
  expires_at: z.string().catch(''),
})

export type VotingSession = z.infer<typeof votingSessionSchema>

const votingSessionResponseSchema = z.object({ session: votingSessionSchema })

/**
 * What the ballot page is told before it renders a form.
 *
 * Narrow by design — the route behind it is public, so the count and the cap are
 * deliberately not here. An unreadable payload reads as a closed session with no
 * reason, which the page renders as its generic "this vote is not open" state.
 */
const ballotSessionConfigSchema = z.object({
  open: z.boolean().catch(false),
  // Normalised to `null` rather than left `undefined` for an absent field: the page
  // switches on this value, and two spellings of "no reason given" would mean the
  // absent case fell through a `?? 'unknown'` differently from the explicit one.
  reason: z.preprocess((value) => value ?? null, refusalReason.nullable().catch(null)),
  document_title: z.string().catch(''),
})

export type BallotSessionConfig = z.infer<typeof ballotSessionConfigSchema>

const ballotConfigResponseSchema = z.object({ session: ballotSessionConfigSchema })

const ballotAcceptedSchema = z.object({
  ballot_id: z.string().min(1),
  corrected: z.boolean().catch(false),
})

/** The refusal body every non-2xx submission carries. `reason` may be absent
 *  (a 500, an API Gateway error page), which reads as `unknown`. */
const ballotRefusalSchema = z.object({ reason: refusalReason.nullish().catch(null) })

/** One anonymous ballot, as the page composes it. Axes are optional because a
 *  submitter may rate some things and not others; the API requires at least one
 *  and refuses a ballot expressing none. */
export interface AnonymousBallot {
  impact?: number
  time_to_market?: number
  confidence?: number
  strategic_fit?: number
  notes?: string
  display_name?: string
  /**
   * The id a previous submission from THIS DEVICE returned, if any.
   *
   * Sending it back corrects that ballot instead of adding one, and costs no
   * slot of the session's cap. It is minted server-side and only ever echoed
   * here; a value the API does not recognise is treated as a first submission
   * rather than as an error.
   */
  ballot_id?: string
}

export type BallotSubmission =
  | { readonly ok: true; readonly ballotId: string; readonly corrected: boolean }
  | { readonly ok: false; readonly failure: BallotFailure }

function sessionPath(sessionId: string): string {
  // Encoded although the id is server-minted: it is a path segment taken
  // straight out of a URL a phone was pointed at, and one carrying a slash or a
  // '?' would otherwise address a different resource.
  return `/voting-sessions/${encodeURIComponent(sessionId)}`
}

export const votingSessionsApi = {
  /**
   * Open a session for ONE document. Authenticated: this is what authorizes
   * anonymous writes, so only a signed-in facilitator may do it.
   */
  createVotingSession: async (input: {
    document_id: string
    document_title?: string
  }): Promise<VotingSession> => {
    const raw = await fetchApi<unknown>('/voting-sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return votingSessionResponseSchema.parse(raw).session
  },

  /** How the vote is going: open or closed, and how many ballots are in. */
  getVotingSession: async (sessionId: string): Promise<VotingSession> => {
    const raw = await fetchApi<unknown>(sessionPath(sessionId))
    return votingSessionResponseSchema.parse(raw).session
  },

  /** Close the session. THIS IS THE REVOCATION — it is what stops the room (and
   *  anyone who kept the link) from submitting anything further. Idempotent. */
  closeVotingSession: async (sessionId: string): Promise<VotingSession> => {
    const raw = await fetchApi<unknown>(`${sessionPath(sessionId)}/close`, { method: 'POST' })
    return votingSessionResponseSchema.parse(raw).session
  },

  /**
   * PUBLIC. What the ballot page needs before it can show a form.
   *
   * A plain `fetch`, not `fetchApi`: no credentials are sent, and a closed or
   * unknown session answers 200 with `open: false` and a reason precisely so this
   * can be rendered as words. Anything that is not a readable 200 is reported as
   * a closed session with no reason, which the page renders as its generic
   * not-open state — a phone should never be shown a blank screen because a fetch
   * failed.
   */
  getBallotSessionConfig: async (sessionId: string): Promise<BallotSessionConfig> => {
    const closed: BallotSessionConfig = { open: false, reason: null, document_title: '' }
    const response = await fetch(`${getBaseUrl()}${sessionPath(sessionId)}/config`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) return closed
    const parsed = ballotConfigResponseSchema.safeParse(await response.json())
    return parsed.success ? parsed.data.session : closed
  },

  /**
   * PUBLIC. Cast one ballot.
   *
   * Returns a RESULT rather than throwing, because every failure here is
   * something the room has to be told in a sentence: the facilitator closed the
   * session, it expired, the cap is reached, or the link is not a session at all.
   * Throwing would hand the page a status code it could not translate.
   */
  submitBallot: async (sessionId: string, ballot: AnonymousBallot): Promise<BallotSubmission> => {
    const response = await fetch(`${getBaseUrl()}${sessionPath(sessionId)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ballot),
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const refusal = ballotRefusalSchema.safeParse(body)
      return {
        ok: false,
        failure: refusal.success && refusal.data.reason ? refusal.data.reason : BALLOT_REFUSAL_UNKNOWN,
      }
    }
    const accepted = ballotAcceptedSchema.safeParse(body)
    if (!accepted.success) return { ok: false, failure: BALLOT_REFUSAL_UNKNOWN }
    return { ok: true, ballotId: accepted.data.ballot_id, corrected: accepted.data.corrected }
  },
}
