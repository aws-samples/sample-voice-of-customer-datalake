/**
 * @fileoverview The anonymous ballot page — what a phone opens after scanning the
 * facilitator's QR.
 *
 * A DELIBERATELY UNAUTHENTICATED SPA ROUTE. Every other route in this app sits
 * behind `ProtectedRoute`, which fails closed in production, so this is a routing
 * decision rather than a page like any other; `routes.tsx` places it as a sibling
 * of `/login`, outside the protected layout, and a test pins that it is not inside
 * it.
 *
 * Why an SPA route and not an API-served HTML page (the pattern the feedback
 * widget's `/iframe` uses):
 *
 *  * Its copy belongs in the eight locale catalogues with the rest of the
 *    product's. An API-served page would either be English-only in front of a room
 *    or would need a second translation mechanism inside a Python handler.
 *  * A ballot page is OURS. The widget's page is served by the API because it is
 *    embedded in customers' own sites; nothing embeds this, and a phone opens it
 *    directly.
 *  * It reuses this app's own building blocks — the same range inputs, the same
 *    typography, the same i18n — rather than a second hand-written stylesheet
 *    inside a Python string.
 *
 * The cost, stated because it is real: this page ships as a lazy chunk of the SPA,
 * so a phone loads the app shell to render a form. That is one request more than
 * an API-served page would need, on a route nobody visits twice.
 *
 * WHAT THIS PAGE MUST SAY, and does: an anonymous ballot is NOT attributed to a
 * person. It counts, it moves the team's score, and it establishes nothing about
 * who thought what. Presenting it otherwise would be the misrepresentation the
 * feature's own risk note is most emphatic about.
 *
 * @module pages/Vote
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import BallotForm from './BallotForm'
import { votingSessionsApi } from '../../api/votingSessionsApi'
import type { AnonymousBallot, BallotFailure } from '../../api/votingSessionsApi'
import type { ReactElement } from 'react'

/**
 * Where a device remembers the ballot it already cast.
 *
 * `localStorage`, keyed by session, so re-opening the page (or re-scanning the
 * QR) offers to CORRECT that ballot rather than casting a second one. This is a
 * convenience, not the control: the server is what refuses a second ballot beyond
 * the cap, and a device that clears its storage simply gets a first submission
 * again — which costs a slot, which the cap bounds. Anything stronger would mean
 * fingerprinting a stranger's phone.
 */
const BALLOT_ID_STORAGE_PREFIX = 'voc-ballot-'

function readStoredBallotId(sessionId: string): string {
  try {
    return window.localStorage.getItem(`${BALLOT_ID_STORAGE_PREFIX}${sessionId}`) ?? ''
  } catch {
    // Private browsing, or storage disabled. A first submission then, which is
    // correct behaviour rather than an error worth showing anybody.
    return ''
  }
}

function storeBallotId(sessionId: string, ballotId: string): void {
  try {
    window.localStorage.setItem(`${BALLOT_ID_STORAGE_PREFIX}${sessionId}`, ballotId)
  } catch {
    // The ballot is cast either way; only the correction affordance is lost.
  }
}

/** The words for each reason a session will not take a ballot.
 *
 *  Every key is a LITERAL: `scripts/i18n-check.mjs` only sees a key it reads
 *  verbatim, so one assembled from a variable is reported unused and becomes a
 *  deletion candidate — leaving this page rendering a raw key path at a room. */
function refusalMessage(failure: BallotFailure, t: (key: string) => string): string {
  switch (failure) {
    case 'not_found': return t('ballot.closed.notFound')
    case 'closed': return t('ballot.closed.closed')
    case 'expired': return t('ballot.closed.expired')
    case 'cap_reached': return t('ballot.closed.capReached')
    case 'unknown': return t('ballot.closed.unknown')
  }
}

function VotePanel({
  title, children,
}: {
  readonly title: string
  readonly children?: ReactElement | string
}): ReactElement {
  return (
    <div className="bg-white rounded-lg border p-4 space-y-2">
      <h2 className="font-medium text-gray-900">{title}</h2>
      {children === undefined ? null : <p className="text-sm text-gray-600">{children}</p>}
    </div>
  )
}

export default function Vote(): ReactElement {
  const { t } = useTranslation('prioritization')
  const { sessionId = '' } = useParams()
  const [failure, setFailure] = useState<BallotFailure | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const { data: session, isPending, isError } = useQuery({
    queryKey: ['ballot-session', sessionId],
    queryFn: () => votingSessionsApi.getBallotSessionConfig(sessionId),
    enabled: sessionId.length > 0,
    // No polling and no refetch on focus: a room submits once, and a phone
    // waking up mid-meeting should not silently replace the form under a
    // half-filled ballot.
    refetchOnWindowFocus: false,
  })

  const submitMutation = useMutation({
    mutationFn: (ballot: AnonymousBallot) => votingSessionsApi.submitBallot(sessionId, {
      ...ballot,
      // Echoed back when this device has voted before, which makes the second
      // submission a CORRECTION of its own ballot rather than a new one.
      ...(readStoredBallotId(sessionId) ? { ballot_id: readStoredBallotId(sessionId) } : {}),
    }),
    onSuccess: (result) => {
      if (result.ok) {
        storeBallotId(sessionId, result.ballotId)
        setSubmitted(true)
        setFailure(null)
        return
      }
      // A refusal, not an exception: the session was closed, expired or full
      // between loading the page and pressing Submit. That is the ordinary case
      // in a meeting, and it deserves the same sentence as finding it closed on
      // arrival.
      setFailure(result.failure)
    },
    onError: () => setFailure('unknown'),
  })

  const body = (): ReactElement => {
    if (!sessionId) return <VotePanel title={t('ballot.closed.title')}>{t('ballot.closed.notFound')}</VotePanel>
    if (isPending) return <VotePanel title={t('ballot.loading')} />
    // A failed CONFIG read is not a statement about the session, so it gets the
    // generic sentence rather than "this vote is closed" — the page must not tell
    // a room a vote is over because a fetch failed. No companion `session ===
    // undefined` check: `isPending` above already excluded the in-flight case, so
    // TanStack's own result type proves the data is here and sonarjs reports the
    // extra comparison as one that can never hold.
    if (isError) {
      return <VotePanel title={t('ballot.closed.title')}>{t('ballot.closed.unknown')}</VotePanel>
    }
    if (failure !== null) {
      return <VotePanel title={t('ballot.closed.title')}>{refusalMessage(failure, t)}</VotePanel>
    }
    if (submitted) {
      return (
        <div role="status" className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-2">
          <h2 className="font-medium text-green-900">{t('ballot.done.title')}</h2>
          <p className="text-sm text-green-800">{t('ballot.done.description')}</p>
        </div>
      )
    }
    if (!session.open) {
      return (
        <VotePanel title={t('ballot.closed.title')}>
          {refusalMessage(session.reason ?? 'unknown', t)}
        </VotePanel>
      )
    }
    return (
      <BallotForm
        onSubmit={(ballot) => submitMutation.mutate(ballot)}
        isSubmitting={submitMutation.isPending}
      />
    )
  }

  return (
    // `max-w-lg` and centred: this is read on a phone, and the same page projected
    // on a laptop should not stretch a slider across a monitor.
    <div className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="mx-auto max-w-lg space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-bold text-gray-900">{t('ballot.title')}</h1>
          {/* WHICH proposal this session scores. A room may have two rows for one
              idea — a PRD and a PR/FAQ are separate documents today — and this
              session scores exactly the one the facilitator opened it for, so the
              title is not decoration. Empty until the config read lands, and blank
              for a session whose facilitator sent none. */}
          {session?.document_title ? (
            <p className="text-base text-gray-700">{session.document_title}</p>
          ) : null}
          {/* THE sentence this page must carry, wherever the page ends up: a
              ballot cast here counts and is not attributed to anybody. Above the
              form rather than under the button, because it is a condition of
              voting and not a footnote about it. */}
          <p className="text-sm text-gray-600">{t('ballot.anonymousNotice')}</p>
        </header>
        {body()}
      </div>
    </div>
  )
}
