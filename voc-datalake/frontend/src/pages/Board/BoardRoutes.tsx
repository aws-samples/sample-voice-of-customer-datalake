/**
 * @fileoverview The standalone boards under one session (`host`): `/board` lists the boards this
 * person may use (exactly one → it opens directly), `/board/:slug` is one board and
 * `/board/:slug/:requestId` one request open on it, and `/board/requests/:requestId` opens that
 * request on its board.
 *
 * @module pages/Board/BoardRoutes
 */
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BoardList from '../FeatureRequests/BoardList'
import FeatureBoard from '../FeatureRequests/FeatureBoard'
import RequestLookup from '../FeatureRequests/RequestLookup'
import { BoardNotFound, BoardTitle } from '../FeatureRequests/BoardPage'
import { BoardHostContext, boardPagePath, useBoardHost } from '../FeatureRequests/boardContext'
import { useBoardList } from '../FeatureRequests/useBoardQueries'
import { BOARD_PATH } from './boardHost'
import { REQUEST_LOOKUP_SEGMENT } from '../FeatureRequests/boardPaths'
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

/** `/board/requests/:requestId`: a request known only by its id, opened on its board. */
function LookedUpRequest() {
  const { requestId = '' } = useParams()
  return <RequestLookup requestId={requestId} />
}

/** `/board`, `/board/:slug[/:requestId]` and `/board/requests/:requestId` over `host` (relative routes inside `/board/*`). */
export default function BoardRoutes({ host }: Readonly<{ host: BoardHost }>) {
  return (
    <BoardHostContext.Provider value={host}>
      <Routes>
        <Route index element={<BoardChooser />} />
        <Route path={`${REQUEST_LOOKUP_SEGMENT}/:requestId`} element={<LookedUpRequest />} />
        {/* The board, and a request open on it (`:slug/:requestId`, which FeatureBoard reads from the path). */}
        <Route path=":slug/*" element={<OneBoard />} />
        <Route path="*" element={<Navigate to={BOARD_PATH} replace />} />
      </Routes>
    </BoardHostContext.Provider>
  )
}
