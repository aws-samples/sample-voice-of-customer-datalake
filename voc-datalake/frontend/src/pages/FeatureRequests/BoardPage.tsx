/**
 * @fileoverview `/feature-requests/:slug`: one feedback board in the app (its name as the page
 * title, the shared FeatureBoard below). A board that does not exist — or is not shared with this
 * person; the API answers both with 404 — says so and links back to the boards.
 */
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import FeatureBoard from './FeatureBoard'
import { APP_BOARD_HOST, BoardHostContext } from './boardContext'
import type { FeatureBoard as Board } from '../../api/featureBoardsSchema'

/** The board's name and description as a page title; shared with `/board/:slug`. */
export function BoardTitle({ board }: Readonly<{ board: Board }>) {
  const { t } = useTranslation('featureRequests')
  return <PageTitle title={board.name} subtitle={board.description === '' ? t('page.boardSubtitle') : board.description} />
}

/** No such board for this person; `boardsPath` is the boards list to go back to. */
export function BoardNotFound({ boardsPath }: Readonly<{ boardsPath: string }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <div className="card p-6 space-y-3">
      <h1 className="text-lg font-semibold text-text-strong">{t('boards.notFoundTitle')}</h1>
      <p className="text-sm text-text">{t('boards.notFound')}</p>
      <Link className="link text-sm" to={boardsPath}>{t('boards.backToBoards')}</Link>
    </div>
  )
}

export default function BoardPage() {
  const { slug = '' } = useParams()
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <BoardHostContext.Provider value={APP_BOARD_HOST}>
        <FeatureBoard key={slug} boardRef={slug} header={(board) => <BoardTitle board={board} />}
          notFound={<BoardNotFound boardsPath={APP_BOARD_HOST.basePath} />} />
      </BoardHostContext.Provider>
    </div>
  )
}
