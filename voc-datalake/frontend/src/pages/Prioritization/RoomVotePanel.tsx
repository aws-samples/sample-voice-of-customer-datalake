/**
 * @fileoverview The facilitator's half of a room vote: open a session for THIS ROW,
 * put its QR on screen, watch the ballots arrive, close it.
 *
 * Lives on the prioritization row rather than on a page of its own because the
 * session is opened FOR ONE ROW and the row is where a facilitator is already
 * looking at it. A row is a project's set of documents, so a room scanning this QR
 * scores the whole proposal.
 *
 * Opening asks first, because it publishes a link anyone can vote through. And on
 * mount the panel looks for the row's open vote, so a reloaded page shows the link,
 * the count and "Close the vote" rather than offering to open a second one.
 *
 * @module pages/Prioritization/RoomVotePanel
 */
import { QrCode, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import SessionQrCode from './SessionQrCode'
import { useRoomVote } from './useRoomVote'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import type { VotingSession } from '../../api/votingSessionsApi'
import type { ReactElement, ReactNode } from 'react'

function SessionStatus({ session }: { readonly session: VotingSession }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <p className="text-sm text-text-strong flex items-center gap-1.5">
      <Users size={14} className="text-aim" aria-hidden="true" />
      {/* `received`, NOT `count`: `count` is i18next's RESERVED option and switches
          the resolver into plural mode, looking for `ballotsIn_one`/`_other` — a raw
          key path in front of a room. Both numbers, because "12 ballots" means
          something different when the cap is 12. */}
      {t('roomVote.ballotsIn', { received: session.ballot_count, cap: session.ballot_cap })}
    </p>
  )
}

function PanelFrame({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <div className="rounded-lg border border-aim/30 bg-aim-subtle p-3 space-y-2">
      <h4 className="font-medium text-text-strong flex items-center gap-1.5">
        <QrCode size={14} className="text-aim" aria-hidden="true" />
        {t('roomVote.title')}
      </h4>
      {children}
    </div>
  )
}

/** Before a vote is open: what it scores, and the button that asks before opening. */
function RoomVoteIntro({ rowTitle, documentCount, isChecking, isOpening, openFailed, onOpen }: {
  readonly rowTitle: string
  readonly documentCount: number
  readonly isChecking: boolean
  readonly isOpening: boolean
  readonly openFailed: boolean
  readonly onOpen: () => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [confirming, setConfirming] = useState(false)
  const confirm = () => {
    setConfirming(false)
    onOpen()
  }
  return (
    <PanelFrame>
      <p className="text-sm text-text">{t('roomVote.description')}</p>
      <p className="text-sm text-text">{t('roomVote.scopeNote', { title: rowTitle })}</p>
      {/* Only for a row holding more than one document; `documents`, not `count`,
          because `count` is i18next's reserved plural option. */}
      {documentCount > 1 ? (
        <p className="text-sm text-text">{t('roomVote.scopeDocuments', { documents: documentCount })}</p>
      ) : null}
      {/* Disabled while the row's open vote is looked up, so a facilitator cannot
          open a second public link before learning the first one is running. */}
      <button type="button" onClick={() => setConfirming(true)} disabled={isChecking || isOpening} className="btn btn-primary">
        {isOpening ? t('roomVote.opening') : t('roomVote.open')}
      </button>
      {isChecking ? <p className="text-xs text-muted" role="status">{t('roomVote.checking')}</p> : null}
      {openFailed ? <p role="alert" className="text-sm text-danger">{t('roomVote.openFailed')}</p> : null}
      <ConfirmModal
        isOpen={confirming}
        title={t('roomVote.confirmTitle')}
        message={t('roomVote.confirmMessage', { title: rowTitle })}
        confirmLabel={t('roomVote.confirmOpen')}
        variant="warning"
        onConfirm={confirm}
        onCancel={() => setConfirming(false)}
      />
    </PanelFrame>
  )
}

/** A vote that is taking ballots: the QR, its link, the count, and Close. */
function OpenVote({ sessionId, rowTitle, session, isClosing, closeFailed, onClose }: {
  readonly sessionId: string
  readonly rowTitle: string
  readonly session: VotingSession
  readonly isClosing: boolean
  readonly closeFailed: boolean
  readonly onClose: () => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <>
      {/* The QR only while the session accepts ballots: a QR cannot say it is dead. */}
      <SessionQrCode sessionId={sessionId} rowTitle={rowTitle} />
      <SessionStatus session={session} />
      <button type="button" onClick={onClose} disabled={isClosing} className="btn btn-secondary">
        {isClosing ? t('roomVote.closing') : t('roomVote.close')}
      </button>
      {closeFailed ? <p role="alert" className="text-sm text-danger">{t('roomVote.closeFailed')}</p> : null}
    </>
  )
}

/** A vote that ended: why, how many ballots it took, and the way to ask again. */
function EndedVote({ session, onStartOver }: {
  readonly session: VotingSession
  readonly onStartOver: () => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <>
      {/* WHY it stopped — pressing Close and running out the clock need different
          words. The branch is OUTSIDE `t()` with both keys written out, because
          `scripts/i18n-check.mjs` reads keys literally. */}
      <p className="text-sm text-text">
        {session.state === 'expired' ? t('roomVote.expired') : t('roomVote.closed')}
      </p>
      <SessionStatus session={session} />
      <button type="button" onClick={onStartOver} className="btn btn-secondary">
        {t('roomVote.openAnother')}
      </button>
    </>
  )
}

/**
 * @param rowId the prioritization row this session scores. Sent to the API, which
 *   derives every ballot's key from it — a public submitter never chooses it.
 * @param rowTitle shown to the room on the ballot page, so a person holding a
 *   phone knows which proposal they are rating.
 * @param documentCount how many documents that row holds, so the facilitator's copy
 *   can say what one ballot covers.
 */
export default function RoomVotePanel({
  rowId, rowTitle, documentCount,
}: {
  readonly rowId: string
  readonly rowTitle: string
  readonly documentCount: number
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const vote = useRoomVote(rowId, rowTitle)

  if (vote.sessionId === null || vote.current === undefined) {
    return (
      <RoomVoteIntro
        rowTitle={rowTitle}
        documentCount={documentCount}
        isChecking={vote.isChecking}
        isOpening={vote.openMutation.isPending}
        openFailed={vote.openMutation.isError}
        onOpen={() => vote.openMutation.mutate()}
      />
    )
  }

  // `state` and not `status`: an EXPIRED session keeps `status: 'open'` for up to
  // ~48 hours (TTL sweep lag), and keying the QR on it puts a live-looking code in
  // front of a room that the API refuses every ballot from.
  return (
    <PanelFrame>
      {vote.current.state === 'open' ? (
        <OpenVote
          sessionId={vote.sessionId}
          rowTitle={rowTitle}
          session={vote.current}
          isClosing={vote.closeMutation.isPending}
          closeFailed={vote.closeMutation.isError}
          onClose={() => vote.closeMutation.mutate()}
        />
      ) : (
        <EndedVote session={vote.current} onStartOver={vote.startOver} />
      )}
      {/* Says what these ballots are, next to the count of them. */}
      <p className="text-xs text-text">{t('roomVote.anonymousNote')}</p>
    </PanelFrame>
  )
}
