/**
 * @fileoverview Boards → one board's editor (`?tab=access&section=boards&board=<id>`): basics,
 * audience, fields, statuses, then Archive / Delete. One Save = one PUT of the whole configuration;
 * a 409 (`slug_taken`, `status_in_use`) is explained in words. The shared unsaved-changes guard
 * catches leaving with edits (Back to boards, another section or page, closing the tab).
 * @module pages/Settings/boards/BoardEditor
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, Save } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { useUnsavedChangesGuard } from '../../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { sameJson } from '../../../lib/sameJson'
import { useIsAdmin } from '../../../store/authStore'
import { SettingsLoading } from '../SettingsNotice'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'
import { afterBoardWrite, boardAdminApi, useAdminBoard } from './boardAdminQueries'
import { PROBLEM_KEYS, boardErrorMessage } from './boardCopy'
import { boardDraftProblems, toChanges, toDraft } from './boardDraft'
import type { BoardDraft } from './boardDraft'
import BoardAudienceFields from './BoardAudienceFields'
import BoardBasicsFields from './BoardBasicsFields'
import BoardFieldsEditor from './BoardFieldsEditor'
import BoardLifecycleActions from './BoardLifecycleActions'
import BoardStatusesEditor from './BoardStatusesEditor'
import { ignoreRejection } from '../../../lib/rejections'

/** The board being edited (shared by the heading and the form: one query). */
const useBoard = useAdminBoard

function useSaveBoard(boardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draft: BoardDraft) => boardAdminApi.updateBoard(boardId, toChanges(draft)),
    onSuccess: (saved: FeatureBoard) => { void afterBoardWrite(queryClient, saved) },
  })
}

function SaveBar({ dirty, problems, pending, error, saved, onSave }: Readonly<{
  dirty: boolean; problems: readonly string[]; pending: boolean; error: string | null; saved: boolean; onSave: () => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
      <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || problems.length > 0 || pending} onClick={onSave}>
        {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
        {t('boards.editor.save')}
      </button>
      {dirty && problems.length === 0 ? <p className="text-xs text-muted">{t('boards.editor.unsaved')}</p> : null}
      {problems.length > 0 ? (
        <ul className="text-xs text-danger">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      ) : null}
      {error === null ? null : <p role="alert" className="text-sm text-danger">{error}</p>}
      {saved && !dirty ? <p role="status" className="text-sm text-ok">{t('boards.saved')}</p> : null}
    </StickyActionBar>
  )
}

/**
 * The draft is null until the first edit, so the form follows the stored board (a refetch, another
 * admin's save) while clean, and keeps the user's edits when the board refetches while dirty (the
 * guard's R2 contract). A successful save drops the draft: the saved board shows.
 */
function BoardForm({ board, canSave, saved, onSavedChange, onDeleted }: Readonly<{
  board: FeatureBoard; canSave: boolean; saved: boolean; onSavedChange: (saved: boolean) => void; onDeleted: () => void
}>) {
  const { t } = useTranslation('settings')
  const stored = toDraft(board)
  const [edits, setEdits] = useState<BoardDraft | null>(null)
  const draft = edits ?? stored
  const save = useSaveBoard(board.board_id)
  const dirty = edits !== null && !sameJson(edits, stored)
  const problems = boardDraftProblems(draft).map((problem) => t(PROBLEM_KEYS[problem]))
  const saveDraft = async (): Promise<boolean> => {
    onSavedChange(false)
    await save.mutateAsync(draft)
    setEdits(null)
    onSavedChange(true)
    return true
  }
  const guard = useUnsavedChangesGuard({
    dirty, canSave: canSave && problems.length === 0, onSave: saveDraft, onDiscard: () => setEdits(null),
  })
  const patch = (next: Partial<BoardDraft>) => {
    onSavedChange(false)
    setEdits((current) => ({ ...(current ?? stored), ...next }))
  }
  const disabled = !canSave
  return (
    <div className="space-y-6">
      {guard.dialog}
      <BoardBasicsFields draft={draft} savedUrl={board.share_url} disabled={disabled} onChange={patch} />
      <BoardAudienceFields draft={draft} disabled={disabled} onChange={patch} />
      <BoardFieldsEditor draft={draft} disabled={disabled} onChange={(fields) => patch({ fields })} />
      <BoardStatusesEditor statuses={draft.statuses} disabled={disabled} onChange={(statuses) => patch({ statuses })} />
      {canSave ? (
        <>
          <SaveBar dirty={dirty} problems={problems} pending={save.isPending} saved={saved}
            error={save.isError ? boardErrorMessage(save.error, t) : null}
            onSave={() => { saveDraft().catch(ignoreRejection) }} />
          <BoardLifecycleActions board={board} dirty={dirty} onDeleted={onDeleted} />
        </>
      ) : null}
    </div>
  )
}

function EditorBody({ boardId, onClose }: Readonly<{ boardId: string; onClose: () => void }>) {
  const { t } = useTranslation('settings')
  const isAdmin = useIsAdmin()
  const [saved, setSaved] = useState(false)
  const board = useBoard(boardId)
  if (board.isPending) return <SettingsLoading text={t('boards.loading')} />
  if (board.isError) {
    return <LoadFailed message={boardErrorMessage(board.error, t)} onRetry={() => { void board.refetch() }} retrying={board.isFetching} />
  }
  return (
    <BoardForm key={board.data.board_id} board={board.data} canSave={isAdmin} saved={saved} onSavedChange={setSaved}
      onDeleted={onClose} />
  )
}

export default function BoardEditor({ boardId, onClose }: Readonly<{ boardId: string; onClose: () => void }>) {
  const { t } = useTranslation('settings')
  const name = useBoard(boardId).data?.name
  return (
    <section className="card space-y-4" aria-labelledby="board-editor-title">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" /> {t('boards.editor.back')}
        </button>
        <h2 id="board-editor-title" className="min-w-0 break-words text-lg font-semibold tracking-tight text-text-strong">
          {name ?? t('boards.editor.title')}
        </h2>
      </div>
      <EditorBody boardId={boardId} onClose={onClose} />
    </section>
  )
}
