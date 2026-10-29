/**
 * @fileoverview The board editor's Archive / Restore and Delete. Archiving hides the board from
 * everyone but admins and keeps its requests; Delete (the shared DeleteBoardDialog) removes the board
 * and, after its name is typed, its requests. Both wait for a saved draft.
 * @module pages/Settings/boards/BoardLifecycleActions
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import DeleteBoardDialog from '../../FeatureRequests/DeleteBoardDialog'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'
import { afterBoardDelete, afterBoardWrite, boardAdminApi } from './boardAdminQueries'
import { boardErrorMessage } from './boardCopy'

export default function BoardLifecycleActions({ board, dirty, onDeleted }: Readonly<{
  board: FeatureBoard; dirty: boolean; onDeleted: () => void
}>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const archive = useMutation({
    mutationFn: () => boardAdminApi.updateBoard(board.board_id, { archived: !board.archived }),
    onSuccess: (saved) => afterBoardWrite(queryClient, saved),
  })
  const afterDelete = async () => {
    // Close first, so nothing still shows (and refetches) the board that is gone.
    onDeleted()
    await afterBoardDelete(queryClient, board)
  }
  const failure = archive.error
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-labelledby="board-lifecycle-title">
      <h3 id="board-lifecycle-title" className="text-sm font-semibold tracking-tight text-text-strong">{t('boards.lifecycle.title')}</h3>
      <p className="text-xs text-muted">
        {t('boards.lifecycle.hint', { count: board.request_count })}
        {dirty ? ` ${t('boards.lifecycle.saveFirst')}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={dirty || archive.isPending} onClick={() => archive.mutate()}>
          {board.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          {board.archived ? t('boards.lifecycle.restore') : t('boards.lifecycle.archive')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm hover:text-danger" disabled={dirty}
          onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" /> {t('boards.lifecycle.delete')}
        </button>
      </div>
      {failure === null ? null : <p role="alert" className="text-sm text-danger">{boardErrorMessage(failure, t)}</p>}
      {confirming
        ? <DeleteBoardDialog board={board} api={boardAdminApi} onCancel={() => setConfirming(false)} onDeleted={afterDelete} />
        : null}
    </section>
  )
}
