/**
 * @fileoverview The standalone boards under one session (`host`): `/board` lists the boards this
 * person may use (exactly one → it opens directly), `/board/:slug` is one board, and a pre-boards
 * `/board?request=<id>` opens that request on its board. A `?board=<slug>` carried through
 * sign-in opens that board.
 *
 * @module pages/Board/BoardRoutes
 */
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BoardList from '../FeatureRequests/BoardList'
import FeatureBoard from '../FeatureRequests/FeatureBoard'
import OldRequestLink from '../FeatureRequests/OldRequestLink'
import { BoardNotFound, BoardTitle } from '../FeatureRequests/BoardPage'
import { BoardHostContext, boardPagePath, useBoardHost } from '../FeatureRequests/boardContext'
import { useBoardList } from '../FeatureRequests/useBoardQueries'
import { BOARD_PARAM, BOARD_PATH, boardLandingPath } from './boardHost'
import type { BoardHost } from '../FeatureRequests/boardContext'

function OneBoard() {
  const { slug = '' } = useParams()
  return (
    <FeatureBoard key={slug} boardRef={slug} header={(board) => <BoardTitle board={board} />}
      notFound={<BoardNotFound boardsPath={BOARD_PATH} />} />
  )
}

/** The boards this person may use; one board opens directly. */
function BoardChooser() {
  const { t } = useTranslation('featureRequests')
  const query = useBoardList()
  const host = useBoardHost()
  const only = query.data?.boards.length === 1 ? query.data.boards[0] : undefined
  if (only !== undefined) return <Navigate to={boardPagePath(host, only.slug)} replace />
  return (
    <div className="space-y-4">
      <PageTitle title={t('page.title')} subtitle={t('boards.standaloneIntro')} />
      <BoardList query={query} />
    </div>
  )
}

function BoardIndex() {
  const [params] = useSearchParams()
  if (params.get(BOARD_PARAM) !== null) return <Navigate to={boardLandingPath(params)} replace />
  const requestId = params.get('request')
  return requestId === null ? <BoardChooser /> : <OldRequestLink requestId={requestId} />
}

/** `/board` and `/board/:slug` over `host` (relative routes inside `/board/*`). */
export default function BoardRoutes({ host }: Readonly<{ host: BoardHost }>) {
  return (
    <BoardHostContext.Provider value={host}>
      <Routes>
        <Route index element={<BoardIndex />} />
        <Route path=":slug" element={<OneBoard />} />
        <Route path="*" element={<Navigate to={BOARD_PATH} replace />} />
      </Routes>
    </BoardHostContext.Provider>
  )
}
