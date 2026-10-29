/**
 * @fileoverview The one board-delete confirmation, used by the board card (Feedback boards) and
 * the board editor (Administration → Privacy & access → Boards). An empty board: a plain confirm.
 * A board with requests: it says the board, its requests and every +1 on them go for good (projects
 * made from them stay), and Delete is enabled only once the board's name is typed. While deleting it
 * stays open and shows how many requests are gone; after a failure it stays open and Delete resumes.
 * The caller renders it only while open, so each opening starts clean.
 * @module pages/FeatureRequests/DeleteBoardDialog
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { BoardDeleteIncompleteError } from '../../api/boardDeletion'
import { useDeleteBoard } from './useDeleteBoard'
import { writeErrorText } from './writeErrorText'
import type { DeleteProgress } from '../../api/boardDeletion'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

type Translate = (key: string, options?: Record<string, unknown>) => string

function messageFor(board: FeatureBoard, withRequests: boolean, t: Translate): string {
  if (!withRequests) return t('boards.deleteMessage', { name: board.name })
  // A stale count of 0 (the API refused a plain delete): the board has requests, how many is unknown.
  return board.request_count > 0
    ? t('boards.deleteWithRequestsMessage', { name: board.name, count: board.request_count })
    : t('boards.deleteWithRequestsMessageStale', { name: board.name })
}

function DeleteProgressLine({ progress }: Readonly<{ progress: DeleteProgress | null }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
      {progress === null ? null : t('boards.deleteProgress', { deleted: progress.deleted, count: progress.deleted + progress.remaining })}
    </p>
  )
}

function DeleteFailure({ error, resumable }: Readonly<{ error: unknown; resumable: boolean }>) {
  const { t } = useTranslation('featureRequests')
  if (error === null || error === undefined) return null
  const text = error instanceof BoardDeleteIncompleteError ? t('boards.deleteIncomplete') : writeErrorText(error, t)
  return (
    <p role="alert" className="mt-2 text-[12px] text-danger break-words">
      {text}{resumable ? ` ${t('boards.deleteResumeHint')}` : ''}
    </p>
  )
}

export default function DeleteBoardDialog({ board, api, onCancel, onDeleted }: Readonly<{
  board: FeatureBoard
  api: Pick<FeatureRequestsApi, 'deleteBoard'>
  onCancel: () => void
  /** After the board is gone: close whatever showed it and refresh the caches. */
  onDeleted: () => Promise<void> | void
}>) {
  const { t } = useTranslation('featureRequests')
  const inputId = useId()
  const state = useDeleteBoard(board, api, onDeleted)
  const withRequests = state.mode === 'withRequests'
  return (
    <ConfirmModal isOpen variant="danger" title={t('boards.deleteTitle')} message={messageFor(board, withRequests, t)}
      confirmLabel={t('actions.delete')} isLoading={state.isPending} confirmDisabled={!state.canConfirm}
      onConfirm={state.confirm} onCancel={onCancel}>
      {withRequests ? (
        <div className="mt-3 space-y-1">
          <label htmlFor={inputId} className="block text-sm font-medium text-text">{t('boards.deleteConfirmNameLabel')}</label>
          <input id={inputId} className="input w-full" value={state.typed} autoComplete="off" spellCheck={false}
            disabled={state.isPending} onChange={(event) => state.setTyped(event.target.value)} />
          <DeleteProgressLine progress={state.progress} />
        </div>
      ) : null}
      <DeleteFailure error={state.error} resumable={withRequests} />
    </ConfirmModal>
  )
}
