/**
 * @fileoverview The standalone feedback boards (docs/feature-requests.md), OUTSIDE the app's
 * protected layout: `/board/login` signs in to the boards' own Cognito pool, `/board` lists the
 * boards this person may use and `/board/:slug` shows one, in a minimal shell (BoardRoutes).
 *
 * - A visitor signed in to the APP uses that session here too (and is sent to the same board in
 *   the app, `/feature-requests/...`, when the deployment has no board pool).
 * - A signed-out visitor of `/board/:slug` signs in and lands back on that board (`?board=`, and
 *   for the emailed link the slug kept with the pending sign-in, services/boardAuth).
 * - Without a board pool and without an app session, the page explains the board is not enabled.
 *
 * @module pages/Board/Board
 */
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import StandaloneShell from '../../components/StandaloneShell/StandaloneShell'
import { useAuthStore } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { getBoardAuth, restoreBoardSession, signOutOfBoard, useBoardSessionStore } from '../../store/boardSessionStore'
import { APP_BOARD_HOST } from '../FeatureRequests/boardContext'
import BoardLogin from './BoardLogin'
import BoardRoutes from './BoardRoutes'
import { BOARD_LOGIN_PATH, BOARD_PARAM, BOARD_PATH, boardHostFor } from './boardHost'
import { withoutSignInParams } from './signInLink'
import type { ReactNode } from 'react'
import type { BoardAuth } from '../../services/boardAuth'

function Shell({ email, onSignOut, children }: Readonly<{ email: string | null; onSignOut?: () => void; children: ReactNode }>) {
  const { t } = useTranslation('featureRequests')
  const brandName = useConfigStore((state) => state.config.brandName)
  const title = brandName === '' ? t('board.title') : t('board.titleWithBrand', { brand: brandName })
  return (
    <StandaloneShell title={title} email={email} signOutLabel={t('board.signOut')} onSignOut={onSignOut}>
      {children}
    </StandaloneShell>
  )
}

function Notice({ title, text }: Readonly<{ title: string; text: string }>) {
  return (
    <div className="card p-6 space-y-2 max-w-lg mx-auto">
      <h1 className="text-lg font-semibold text-text-strong">{title}</h1>
      <p className="text-sm text-text">{text}</p>
    </div>
  )
}

/** The app session on `/board`: its links and navigation kept on `/board` (a visitor already here stays here). */
function AppSessionBoards() {
  const host = useMemo(() => ({ ...APP_BOARD_HOST, basePath: BOARD_PATH }), [])
  return <BoardRoutes host={host} />
}

/** `/board/<slug>…` → the slug, else null (`/board`, `/board/login`). */
function slugOf(pathname: string): string | null {
  const [, rest = ''] = pathname.split(`${BOARD_PATH}/`)
  const slug = rest.split('/')[0] ?? ''
  return slug === '' || slug === 'login' ? null : decodeURIComponent(slug)
}

/** The sign-in page's search for a signed-out visitor: the link's params, plus the board they opened. */
function loginSearch(pathname: string, search: string): string {
  const params = new URLSearchParams(withoutSignInParams(search))
  const slug = slugOf(pathname)
  if (slug !== null) params.set(BOARD_PARAM, slug)
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/** The boards over the board session: sign-in when there is none, the boards when there is. */
function BoardSession({ auth }: Readonly<{ auth: BoardAuth }>) {
  const { t } = useTranslation('featureRequests')
  const { status, email, landing } = useBoardSessionStore()
  const location = useLocation()
  const host = useMemo(() => boardHostFor(auth), [auth])
  useEffect(() => {
    if (status === 'unknown') void restoreBoardSession(auth)
  }, [auth, status])
  if (status === 'unknown') return <Shell email={null}><p className="text-sm text-muted">{t('loading')}</p></Shell>
  return (
    <Routes>
      <Route path="login" element={status === 'signedIn' ? <Navigate to={landing ?? `${BOARD_PATH}${withoutSignInParams(location.search)}`} replace /> : (
        <Shell email={null}><div className="flex justify-center"><BoardLogin auth={auth} /></div></Shell>
      )} />
      <Route path="*" element={status === 'signedIn' ? (
        <Shell email={email} onSignOut={() => signOutOfBoard(auth)}><BoardRoutes host={host} /></Shell>
      ) : <Navigate to={`${BOARD_LOGIN_PATH}${loginSearch(location.pathname, location.search)}`} replace />} />
    </Routes>
  )
}

export default function Board() {
  const { t } = useTranslation('featureRequests')
  const appSignedIn = useAuthStore((state) => state.isAuthenticated)
  const appEmail = useAuthStore((state) => state.user?.email ?? null)
  const location = useLocation()
  const auth = getBoardAuth()
  if (appSignedIn) {
    if (!auth) {
      const slug = slugOf(location.pathname)
      const path = slug === null ? APP_BOARD_HOST.basePath : `${APP_BOARD_HOST.basePath}/${encodeURIComponent(slug)}`
      return <Navigate to={`${path}${location.search}`} replace />
    }
    return <Shell email={appEmail}><AppSessionBoards /></Shell>
  }
  if (!auth) {
    return (
      <Shell email={null}>
        <Notice title={t('board.notEnabledTitle')} text={import.meta.env.DEV ? t('board.notEnabledDev') : t('board.notEnabled')} />
      </Shell>
    )
  }
  return <BoardSession auth={auth} />
}
