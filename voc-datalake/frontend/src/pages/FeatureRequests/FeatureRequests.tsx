/**
 * @fileoverview `/feature-requests` (docs/feature-requests.md): the feedback boards as cards, over
 * the app session; an admin's gear opens Administration → Privacy & access → Boards. A pre-boards
 * request link (`?request=<id>`) opens that request on its board instead. Board-pool users reach
 * the same boards at `/board`.
 */
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BoardList from './BoardList'
import OldRequestLink from './OldRequestLink'
import { APP_BOARD_HOST, BOARDS_ADMIN_PATH, BoardHostContext, isAppAdmin } from './boardContext'
import { useBoardList } from './useBoardQueries'

function Boards() {
  const { t } = useTranslation('featureRequests')
  const query = useBoardList()
  const isAdmin = isAppAdmin(query.data?.viewer)
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title={t('page.title')} subtitle={t('page.subtitle')} />
        {isAdmin ? (
          <Link className="btn btn-ghost btn-sm" to={BOARDS_ADMIN_PATH} aria-label={t('boards.configure')} title={t('boards.configure')}>
            <Settings size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <BoardList query={query} />
    </>
  )
}

export default function Page() {
  const [params] = useSearchParams()
  const requestId = params.get('request')
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <BoardHostContext.Provider value={APP_BOARD_HOST}>
        {requestId === null ? <Boards /> : <OldRequestLink requestId={requestId} />}
      </BoardHostContext.Provider>
    </div>
  )
}
