/**
 * @fileoverview A pre-boards request link (`/feature-requests?request=<id>`, `/board?request=<id>`)
 * opens the request on its board: the request names its `board_id` (none = the seeded board), the
 * boards listing gives that board's slug, and the visitor lands on `<boards>/<slug>?request=<id>`.
 *
 * @module pages/FeatureRequests/OldRequestLink
 */
import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router-dom'
import { SEEDED_BOARD_ID } from '../../api/featureBoardsSchema'
import { boardPagePath, useBoardHost } from './boardContext'
import { useBoardList, useRequestDetail } from './useBoardQueries'

export default function OldRequestLink({ requestId }: Readonly<{ requestId: string }>) {
  const { t } = useTranslation('featureRequests')
  const host = useBoardHost()
  const detail = useRequestDetail(requestId)
  const boards = useBoardList()
  if (detail.isError || boards.isError) {
    return (
      <div className="card p-6 space-y-3">
        <p role="alert" className="text-sm text-text">{t('errors.notFound')}</p>
        <Link className="link text-sm" to={host.basePath}>{t('boards.backToBoards')}</Link>
      </div>
    )
  }
  if (!detail.data || !boards.data) return <p className="text-sm text-muted">{t('loading')}</p>
  const boardId = detail.data.request.board_id ?? SEEDED_BOARD_ID
  // The slug when the listing has the board; its id otherwise (every board route takes either).
  const boardRef = boards.data.boards.find((board) => board.board_id === boardId)?.slug ?? boardId
  const query = new URLSearchParams({ request: requestId }).toString()
  return <Navigate to={`${boardPagePath(host, boardRef)}?${query}`} replace />
}
