/**
 * @fileoverview `/review/:shareId`: a PR/FAQ or PRD shared for review (docs/document-review.md),
 * OUTSIDE the app's protected layout like `/board`.
 *
 * - A visitor signed in to the APP reviews with that session (the review routes accept both pools).
 * - Anyone else signs in with the board pool's emailed code, inline on this page; the link and the
 *   verified email decide what they may open (the API answers one "no longer valid" for a revoked,
 *   expired or not-for-you link).
 *
 * @module pages/Review/Review
 */
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import BoardLogin from '../Board/BoardLogin'
import StandaloneShell from '../../components/StandaloneShell/StandaloneShell'
import ReviewDocument from './ReviewDocument'
import { appTransport, boardTransport } from '../../api/featureRequestsApi'
import { isReviewPath } from '../../services/boardAuth'
import { useAuthStore } from '../../store/authStore'
import { getBoardAuth, restoreBoardSession, signOutOfBoard, useBoardSessionStore } from '../../store/boardSessionStore'
import type { ReactNode } from 'react'
import type { BoardAuth } from '../../services/boardAuth'

function ReviewShell({ email, onSignOut, children }: Readonly<{ email: string | null; onSignOut?: () => void; children: ReactNode }>) {
  const { t } = useTranslation('components')
  return (
    <StandaloneShell title={t('reviewPage.title')} email={email} signOutLabel={t('reviewPage.signOut')} width="wide" onSignOut={onSignOut}>
      {children}
    </StandaloneShell>
  )
}

function BoardReview({ auth, shareId }: Readonly<{ auth: BoardAuth; shareId: string }>) {
  const { t } = useTranslation('components')
  const { status, email } = useBoardSessionStore()
  const transport = useMemo(() => boardTransport((force) => auth.getIdToken(force)), [auth])
  useEffect(() => {
    if (status === 'unknown') void restoreBoardSession(auth)
  }, [auth, status])
  if (status === 'unknown') return <ReviewShell email={null}><p className="text-sm text-muted">{t('reviewPage.loading')}</p></ReviewShell>
  if (status === 'signedOut') {
    return (
      <ReviewShell email={null}>
        <div className="flex justify-center">
          <BoardLogin auth={auth} returnTo={`/review/${shareId}`} title={t('reviewPage.signInTitle')}
            intro={auth.mode === 'code' ? t('reviewPage.signInIntroCode') : t('reviewPage.signInIntro')} />
        </div>
      </ReviewShell>
    )
  }
  return (
    <ReviewShell email={email} onSignOut={() => signOutOfBoard(auth)}>
      <ReviewDocument shareId={shareId} fetchApi={transport} session="board" />
    </ReviewShell>
  )
}

export default function Review() {
  const { t } = useTranslation('components')
  const { shareId = '' } = useParams()
  const appSignedIn = useAuthStore((state) => state.isAuthenticated)
  const appEmail = useAuthStore((state) => state.user?.email ?? null)
  const auth = getBoardAuth()
  if (!isReviewPath(`/review/${shareId}`)) {
    return <ReviewShell email={null}><p className="text-sm text-text">{t('reviewPage.gone')}</p></ReviewShell>
  }
  if (appSignedIn) {
    return <ReviewShell email={appEmail}><ReviewDocument shareId={shareId} fetchApi={appTransport} session="app" /></ReviewShell>
  }
  if (auth === null) {
    return <ReviewShell email={null}><p className="text-sm text-text">{t('reviewPage.notEnabled')}</p></ReviewShell>
  }
  return <BoardReview auth={auth} shareId={shareId} />
}
