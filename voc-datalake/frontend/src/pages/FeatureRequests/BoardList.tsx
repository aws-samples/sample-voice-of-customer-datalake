/**
 * @fileoverview The feedback boards a person may use, as cards (BoardCard), shared by the in-app
 * page and the standalone `/board`. Copy link writes the board's share link and confirms it in a
 * short toast (a polite live region, so a screen reader hears it too).
 *
 * @module pages/FeatureRequests/BoardList
 */
import { Check, LayoutGrid } from 'lucide-react'
import { useCallback } from 'react'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import BoardCard from './BoardCard'
import { BOARDS_ADMIN_PATH, isAppAdmin } from './boardContext'
import type { BoardViewer } from '../../api/featureRequestsApi'
import type { FeatureBoard } from '../../api/featureBoardsSchema'

const TOAST_MS = 2500

type ToastMessage = 'copied' | 'failed'

/** Copy a link and say so for a moment; a refused clipboard says that instead. */
function useCopyToast() {
  const { tryCopy, markCopied, copiedKey } = useCopyToClipboard(TOAST_MS)
  const copy = useCallback((url: string) => {
    void tryCopy(url, 'copied').then((ok) => { if (!ok) markCopied('failed') })
  }, [tryCopy, markCopied])
  const message: ToastMessage | null = copiedKey === 'copied' || copiedKey === 'failed' ? copiedKey : null
  return { message, copy }
}

function CopyToast({ message }: Readonly<{ message: ToastMessage | null }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      {message === null ? null : (
        <p className="card px-4 py-2 text-sm text-text-strong shadow-lg flex items-center gap-2">
          {message === 'copied' ? <Check size={14} className="text-ok" aria-hidden="true" /> : null}
          {message === 'copied' ? t('boards.linkCopied') : t('boards.copyFailed')}
        </p>
      )}
    </div>
  )
}

function EmptyBoards({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <div className="card text-center py-12 space-y-2">
      <div className="w-12 h-12 mx-auto rounded-full bg-accent-subtle flex items-center justify-center">
        <LayoutGrid size={20} className="text-accent-text" aria-hidden="true" />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text-strong">{t('boards.emptyTitle')}</h2>
      <p className="text-sm text-muted">
        {isAdmin ? (
          <Trans i18nKey="boards.emptyAdmin" ns="featureRequests"
            components={{ admin: <Link to={BOARDS_ADMIN_PATH} className="text-accent-text underline" /> }} />
        ) : t('boards.empty')}
      </p>
    </div>
  )
}

export interface BoardListQuery {
  readonly data?: { readonly boards: readonly FeatureBoard[]; readonly viewer: BoardViewer }
  readonly isLoading: boolean
  readonly isFetching: boolean
  readonly refetch: () => unknown
}

/** The cards of `query`'s boards; admin controls only for an app-pool admin. */
export default function BoardList({ query }: Readonly<{ query: BoardListQuery }>) {
  const { t } = useTranslation('featureRequests')
  const toast = useCopyToast()
  if (query.isLoading) return <p className="text-sm text-muted">{t('loading')}</p>
  if (!query.data) {
    return <LoadFailed message={t('boards.loadFailed')} onRetry={query.refetch} retrying={query.isFetching} />
  }
  const { boards, viewer } = query.data
  const isAdmin = isAppAdmin(viewer)
  return (
    <>
      {boards.length === 0 ? <EmptyBoards isAdmin={isAdmin} /> : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label={t('boards.listLabel')}>
          {boards.map((board) => <BoardCard key={board.board_id} board={board} isAdmin={isAdmin} onCopy={toast.copy} />)}
        </ul>
      )}
      <CopyToast message={toast.message} />
    </>
  )
}
