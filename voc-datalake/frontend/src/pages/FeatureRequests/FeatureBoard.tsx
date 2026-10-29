/**
 * @fileoverview One feedback board, shared by the in-app page and `/board/:slug`: its figures, the
 * request list, "New request", and the request detail deep-linked as `?request=<id>`. Everything
 * below it reads the board (fields, statuses, template) from `CurrentBoardContext`.
 *
 * Render it inside a `BoardHostContext` provider, which supplies the session's API.
 *
 * @module pages/FeatureRequests/FeatureBoard
 */
import { PauseCircle, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { SEEDED_BOARD } from '../../api/featureBoardsSchema'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import NewRequestModal from './NewRequestModal'
import RequestDetailModal from './RequestDetailModal'
import RequestList from './RequestList'
import { BoardSummary } from './RequestTotals'
import { rememberedName } from './boardFormat'
import { CurrentBoardContext } from './boardContext'
import { useRequestList } from './useBoardQueries'
import type { ReactNode } from 'react'
import type { FeatureBoard as Board } from '../../api/featureBoardsSchema'

const REQUEST_PARAM = 'request'

function useOpenRequest(): readonly [string | null, (requestId: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const open = (requestId: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (requestId === null) next.delete(REQUEST_PARAM)
      else next.set(REQUEST_PARAM, requestId)
      return next
      // Rendered before the next event (useBoardControls explains the stale-params race).
    }, { flushSync: true })
  }
  return [params.get(REQUEST_PARAM), open]
}

/** Why the list could not be shown: a 404 (no such board, or not shared with this person), a refused sign-in (403), else a retryable failure. */
function ListFailure({ error, retry, retrying, notFound }: Readonly<{
  error: unknown; retry: () => void; retrying: boolean; notFound: ReactNode
}>) {
  const { t } = useTranslation('featureRequests')
  const status = apiErrorStatus(error)
  if (status === 404) return <>{notFound}</>
  // 403: the caller's token is valid but not accepted here (unverified email, another pool) — retrying cannot help.
  if (status === 403) return <p role="alert" className="text-sm text-danger break-words">{t('list.notAccepted')}</p>
  return <LoadFailed message={t('list.loadFailed')} onRetry={retry} retrying={retrying} />
}

/** A paused board: readable as before, but closed to new requests, +1s and edits until an admin resumes it. */
function PausedNotice() {
  const { t } = useTranslation('featureRequests')
  return (
    <p role="status" className="card p-3 flex items-center gap-2 text-sm text-text-strong" data-testid="board-paused-notice">
      <PauseCircle size={16} className="text-warn shrink-0" aria-hidden="true" />{t('boards.pausedNotice')}
    </p>
  )
}

/** The intro and "New request"; on a paused board the notice instead of "New request". */
function BoardToolbar({ paused, onNew }: Readonly<{ paused: boolean; onNew: () => void }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <>
      {paused ? <PausedNotice /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t('list.intro')}</p>
        {paused ? null : (
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus size={16} aria-hidden="true" />{t('new.open')}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * `boardRef` = the board's slug or id from the URL. `notFound` is shown when the board does not
 * exist for this person (a 404 never says which).
 */
export default function FeatureBoard({ boardRef, notFound, header }: Readonly<{
  boardRef: string
  notFound: ReactNode
  /** Above the board, given the board once loaded (the page title). */
  header?: (board: Board) => ReactNode
}>) {
  const { t } = useTranslation('featureRequests')
  const list = useRequestList(boardRef)
  const [openId, setOpenId] = useOpenRequest()
  const [creating, setCreating] = useState(false)
  if (list.isLoading) return <p className="text-sm text-muted">{t('loading')}</p>
  if (list.isError || !list.data) {
    return <ListFailure error={list.error} retry={() => { void list.refetch() }} retrying={list.isFetching} notFound={notFound} />
  }
  const { requests, viewer } = list.data
  const board = list.data.board ?? SEEDED_BOARD
  const initialName = viewer.name === '' ? rememberedName() : viewer.name
  const openTitle = requests.find((request) => request.request_id === openId)?.title ?? ''
  return (
    <CurrentBoardContext.Provider value={board}>
      <div className="space-y-4">
        {header?.(board)}
        <BoardSummary requests={requests} />
        <BoardToolbar paused={board.paused} onNew={() => setCreating(true)} />
        <RequestList requests={requests} onOpen={setOpenId} />
        {creating ? (
          <NewRequestModal initialName={initialName} onClose={() => setCreating(false)}
            onCreated={(requestId) => { setCreating(false); setOpenId(requestId) }} />
        ) : null}
        {openId === null ? null : (
          <RequestDetailModal key={openId} requestId={openId} title={openTitle} viewer={viewer}
            initialName={initialName} onClose={() => setOpenId(null)} />
        )}
      </div>
    </CurrentBoardContext.Provider>
  )
}
