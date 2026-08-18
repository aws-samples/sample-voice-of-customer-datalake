/**
 * @fileoverview The facilitator's half of a room vote: open a session for THIS ROW,
 * put its QR on screen, watch the ballots arrive, close it.
 *
 * Lives on the prioritization row rather than on a page of its own because the
 * session is opened FOR ONE ROW and the row is where a facilitator is already
 * looking at it. A row is a project's set of documents, so a room scanning this QR
 * scores the whole proposal — the limitation this panel used to name in words (a
 * PRD row and a PR/FAQ row of one idea being two votes) is gone, and the panel now
 * says what the one ballot covers instead.
 *
 * @module pages/Prioritization/RoomVotePanel
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { QrCode, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import SessionQrCode from './SessionQrCode'
import { ballotCountRefetchInterval } from './roomVotePolling'
import { votingSessionsApi } from '../../api/votingSessionsApi'
import type { VotingSession } from '../../api/votingSessionsApi'
import type { ReactElement } from 'react'

function SessionStatus({ session }: { readonly session: VotingSession }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <p className="text-sm text-indigo-900 flex items-center gap-1.5">
      <Users size={14} className="text-indigo-500" />
      {/* Plain interpolated numbers rather than a `count` plural: plural forms
          differ per locale and a missing one renders the raw key path in front of
          a room. Both numbers are shown, because "12 ballots" means something
          different when the cap is 12.
          `received`, NOT `count`: `count` is i18next's RESERVED option, so passing
          it switches the resolver into plural mode and it looks for
          `ballotsIn_one`/`ballotsIn_other` first — which is the exact fragility
          this comment claims to be avoiding, invited by the name of the variable
          holding the number. */}
      {t('roomVote.ballotsIn', { received: session.ballot_count, cap: session.ballot_cap })}
    </p>
  )
}

/**
 * @param rowId the prioritization row this session scores. Sent to the API, which
 *   derives every ballot's key from it — a public submitter never chooses it.
 * @param rowTitle shown to the room on the ballot page, so a person holding a
 *   phone knows which proposal they are rating.
 * @param documentCount how many documents that row holds, so the facilitator's copy
 *   can say what one ballot covers rather than leaving a room to assume it is one
 *   document.
 */
export default function RoomVotePanel({
  rowId, rowTitle, documentCount,
}: {
  readonly rowId: string
  readonly rowTitle: string
  readonly documentCount: number
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [sessionId, setSessionId] = useState<string | null>(null)

  const openMutation = useMutation({
    mutationFn: () => votingSessionsApi.createVotingSession({
      row_id: rowId,
      row_title: rowTitle,
    }),
    onSuccess: (session) => setSessionId(session.session_id),
  })

  // Polled while open so the facilitator can watch the room vote, and so a
  // session that has been closed (or has expired) stops claiming to be open.
  const { data: session } = useQuery({
    queryKey: ['voting-session', sessionId],
    queryFn: () => votingSessionsApi.getVotingSession(sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: (query) => ballotCountRefetchInterval(query.state.data),
    initialData: openMutation.data,
  })

  const closeMutation = useMutation({
    mutationFn: () => votingSessionsApi.closeVotingSession(sessionId ?? ''),
  })

  /**
   * Back to the un-opened state, so a second round can be run in the same
   * meeting.
   *
   * Needed because a session ends in a way NOBODY CHOSE: it expires on a wall
   * clock. Without this the panel showed the ended copy until the page was
   * reloaded, so a facilitator whose vote timed out mid-discussion had to reload
   * the prioritization page — losing their expanded row — to ask the room again.
   *
   * Both mutations are reset as well as the id. `closeMutation.data` overrides the
   * query below by design (a close is authoritative the instant it returns), so
   * leaving it behind would make the next session read as closed the moment it
   * opened; and a stale `openMutation.data` would seed the query with the previous
   * session as `initialData`.
   */
  const startOver = () => {
    setSessionId(null)
    closeMutation.reset()
    openMutation.reset()
  }

  // The CLOSED reading wins whenever either side says so: the close mutation's
  // own response is authoritative the instant it returns, and waiting for the
  // next poll would leave "open" on a projector after the facilitator pressed
  // Close. A stale "open" is the dangerous direction — it is the state in which
  // ballots are still being accepted.
  const current = closeMutation.data ?? session
  // `state` and not `status`: the two differ for a session that EXPIRED, which is
  // the ordinary end of a vote nobody remembered to close. `status` stays `open`
  // on such a record for up to about 48 hours (that is TTL sweep lag, not a bug),
  // so keying the QR on it puts a live-looking code in front of a room that the
  // API refuses every ballot from.
  const isOpen = current?.state === 'open'

  if (sessionId === null || current === undefined) {
    return (
      <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 space-y-2">
        <h4 className="font-medium text-indigo-900 flex items-center gap-1.5">
          <QrCode size={14} className="text-indigo-500" />
          {t('roomVote.title')}
        </h4>
        <p className="text-sm text-indigo-800">{t('roomVote.description')}</p>
        {/* Names the row the session will score. "One vote on this proposal" is what
            a facilitator has to be able to tell a room, and it is now true — the
            hedge this line used to carry (a PRD row and a PR/FAQ row being separate
            votes) is gone. */}
        <p className="text-sm text-indigo-800">{t('roomVote.scopeNote', { title: rowTitle })}</p>
        {/* And that the one ballot covers the whole set, for a row that holds more
            than one document. Only then: on a single-document row there is nothing
            to clarify, which also lets the sentence be plural rather than a `count`
            plural whose forms differ per locale. `documents`, not `count`, because
            `count` is i18next's reserved plural option. */}
        {documentCount > 1 ? (
          <p className="text-sm text-indigo-800">
            {t('roomVote.scopeDocuments', { documents: documentCount })}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => openMutation.mutate()}
          disabled={openMutation.isPending}
          className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-500"
        >
          {openMutation.isPending ? t('roomVote.opening') : t('roomVote.open')}
        </button>
        {openMutation.isError ? (
          <p role="alert" className="text-sm text-red-700">{t('roomVote.openFailed')}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 space-y-3">
      <h4 className="font-medium text-indigo-900 flex items-center gap-1.5">
        <QrCode size={14} className="text-indigo-500" />
        {t('roomVote.title')}
      </h4>
      {isOpen ? (
        <>
          {/* The QR only while the session accepts ballots. Leaving it up after
              the vote closed would send a room to a page that refuses them, and a
              QR cannot say that about itself. */}
          <SessionQrCode sessionId={sessionId} rowTitle={rowTitle} />
          <SessionStatus session={current} />
          <button
            type="button"
            onClick={() => closeMutation.mutate()}
            disabled={closeMutation.isPending}
            className="px-3 py-2 rounded-lg text-sm font-medium text-indigo-800 bg-white border border-indigo-200 hover:bg-indigo-100 disabled:text-gray-400"
          >
            {closeMutation.isPending ? t('roomVote.closing') : t('roomVote.close')}
          </button>
          {closeMutation.isError ? (
            <p role="alert" className="text-sm text-red-700">{t('roomVote.closeFailed')}</p>
          ) : null}
        </>
      ) : (
        <>
          {/* WHY it stopped, because the two endings need different words: a
              facilitator who pressed Close knows what happened, and one whose
              session ran out its clock is otherwise left thinking somebody else
              ended their vote. */}
          {/* The branch is OUTSIDE `t()`, with both keys written out verbatim:
              `scripts/i18n-check.mjs` reads keys literally, so `t(cond ? a : b)`
              makes both of them look unreferenced and turns them into deletion
              candidates in a cleanup pass — leaving a raw key path in front of a
              room. Same trap `SCORABLE_TYPE_META` and the ballot page's
              `refusalMessage` document. */}
          <p className="text-sm text-indigo-800">
            {current.state === 'expired' ? t('roomVote.expired') : t('roomVote.closed')}
          </p>
          <SessionStatus session={current} />
          {/* The way back. A vote can end without the facilitator doing anything —
              it expires — so an ended panel with no exit means reloading the page
              to ask the room a second time, and a reload collapses the row they
              were reading. */}
          <button
            type="button"
            onClick={startOver}
            className="px-3 py-2 rounded-lg text-sm font-medium text-indigo-800 bg-white border border-indigo-200 hover:bg-indigo-100"
          >
            {t('roomVote.openAnother')}
          </button>
        </>
      )}
      {/* Says what these ballots are, next to the count of them: they move the
          team's score and they attribute nothing to anybody. */}
      <p className="text-xs text-indigo-800">{t('roomVote.anonymousNote')}</p>
    </div>
  )
}
