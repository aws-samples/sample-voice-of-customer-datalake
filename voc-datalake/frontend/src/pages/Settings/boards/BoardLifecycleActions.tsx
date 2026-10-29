/**
 * @fileoverview The board editor's Pause / Resume, Archive / Restore and Delete (the shared
 * BoardLifecycleButtons). Pausing is temporary: the board stays readable but takes no new request,
 * +1 or edit. Archiving is the step before deletion: the board leaves its audience's view and keeps
 * its requests; Delete is offered only on an archived board. Every action waits for a saved draft.
 * @module pages/Settings/boards/BoardLifecycleActions
 */
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import BoardLifecycleButtons from '../../FeatureRequests/BoardLifecycleButtons'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'
import { afterBoardDelete, afterBoardWrite, boardAdminApi } from './boardAdminQueries'

export default function BoardLifecycleActions({ board, dirty, onDeleted }: Readonly<{
  board: FeatureBoard; dirty: boolean; onDeleted: () => void
}>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const afterDelete = async () => {
    // Close first, so nothing still shows (and refetches) the board that is gone.
    onDeleted()
    await afterBoardDelete(queryClient, board)
  }
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-labelledby="board-lifecycle-title">
      <h3 id="board-lifecycle-title" className="text-sm font-semibold tracking-tight text-text-strong">{t('boards.lifecycle.title')}</h3>
      <p className="text-xs text-muted">
        {t('boards.lifecycle.hint', { count: board.request_count })}
        {dirty ? ` ${t('boards.lifecycle.saveFirst')}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <BoardLifecycleButtons board={board} api={boardAdminApi} disabled={dirty} buttonClassName="btn btn-secondary btn-sm"
          onSaved={(saved) => afterBoardWrite(queryClient, saved)} onDeleted={afterDelete} />
      </div>
    </section>
  )
}
