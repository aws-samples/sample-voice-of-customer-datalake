/**
 * @fileoverview The facilitator's half of a room vote: open a session for THIS
 * document, put its QR on screen, watch the ballots arrive, close it.
 *
 * Lives on the prioritization row rather than on a page of its own because the
 * session is opened FOR ONE DOCUMENT and the row is where a facilitator is already
 * looking at that document. That also makes the known limitation visible where it
 * bites: a proposal that exists as both a PRD row and a PR/FAQ row is two
 * documents today, so a room scanning this QR scores this row. The panel names the
 * document it is opening a vote for, and says so in words.
 *
 * @module pages/Prioritization/RoomVotePanel
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { QrCode, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import SessionQrCode from './SessionQrCode'
import { votingSessionsApi } from '../../api/votingSessionsApi'
import type { VotingSession } from '../../api/votingSessionsApi'
import type { ReactElement } from 'react'

/**
 * How often the ballot count is re-read while a session is open.
 *
 * Frequent enough that a facilitator can see the room voting (which is the whole
 * reason the count is on screen — it is how they know when to stop waiting), and
 * slow enough that a session left open on a projector for an hour costs a few
 * hundred cheap reads rather than thousands. Stops entirely once the session is
 * closed: there is nothing further to count.
 */
const BALLOT_COUNT_POLL_MS = 5000

function SessionStatus({ session }: { readonly session: VotingSession }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <p className="text-sm text-indigo-900 flex items-center gap-1.5">
      <Users size={14} className="text-indigo-500" />
      {/* A plain interpolated number rather than a `count` plural: plural forms
          differ per locale and a missing one renders the raw key path in front of
          a room. Both numbers are shown, because "12 ballots" means something
          different when the cap is 12. */}
      {t('roomVote.ballotsIn', { count: session.ballot_count, cap: session.ballot_cap })}
    </p>
  )
}

/**
 * @param documentId the document this session scores. Sent to the API, which
 *   derives every ballot's key from it — a public submitter never chooses it.
 * @param documentTitle shown to the room on the ballot page, so a person holding a
 *   phone knows which proposal they are rating.
 */
export default function RoomVotePanel({
  documentId, documentTitle,
}: {
  readonly documentId: string
  readonly documentTitle: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [sessionId, setSessionId] = useState<string | null>(null)

  const openMutation = useMutation({
    mutationFn: () => votingSessionsApi.createVotingSession({
      document_id: documentId,
      document_title: documentTitle,
    }),
    onSuccess: (session) => setSessionId(session.session_id),
  })

  // Polled while open so the facilitator can watch the room vote, and so a
  // session that has been closed (or has expired) stops claiming to be open.
  const { data: session } = useQuery({
    queryKey: ['voting-session', sessionId],
    queryFn: () => votingSessionsApi.getVotingSession(sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'open' ? BALLOT_COUNT_POLL_MS : false),
    initialData: openMutation.data,
  })

  const closeMutation = useMutation({
    mutationFn: () => votingSessionsApi.closeVotingSession(sessionId ?? ''),
  })

  // The CLOSED reading wins whenever either side says so: the close mutation's
  // own response is authoritative the instant it returns, and waiting for the
  // next poll would leave "open" on a projector after the facilitator pressed
  // Close. A stale "open" is the dangerous direction — it is the state in which
  // ballots are still being accepted.
  const current = closeMutation.data ?? session
  const isOpen = current?.status === 'open'

  if (sessionId === null || current === undefined) {
    return (
      <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 space-y-2">
        <h4 className="font-medium text-indigo-900 flex items-center gap-1.5">
          <QrCode size={14} className="text-indigo-500" />
          {t('roomVote.title')}
        </h4>
        <p className="text-sm text-indigo-800">{t('roomVote.description')}</p>
        {/* Names the ONE document the session will score, because a room scanning
            a QR for a PRD row is not also scoring the PR/FAQ row of the same idea. */}
        <p className="text-sm text-indigo-800">{t('roomVote.scopeNote', { title: documentTitle })}</p>
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
          <SessionQrCode sessionId={sessionId} documentTitle={documentTitle} />
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
          <p className="text-sm text-indigo-800">{t('roomVote.closed')}</p>
          <SessionStatus session={current} />
        </>
      )}
      {/* Says what these ballots are, next to the count of them: they move the
          team's score and they attribute nothing to anybody. */}
      <p className="text-xs text-indigo-800">{t('roomVote.anonymousNote')}</p>
    </div>
  )
}
