/**
 * @fileoverview An admin's Pause / Resume, Archive / Restore and Delete of one board, shared by the
 * board card (Feedback boards) and the board editor (Administration → Privacy & access → Boards).
 *
 * - **Pause** is temporary: the board stays readable by its audience, but nobody posts, adds a +1 or
 *   edits until it is resumed (the API answers 409 `board_paused`). Pause asks first; Resume does not.
 * - **Archive** is the permanent step before deletion: the board leaves its audience's view (and the
 *   sign-up audience), its requests are kept. Archive asks first; Restore does not.
 * - **Delete** is offered only on an archived board (DeleteBoardDialog).
 *
 * @module pages/FeatureRequests/BoardLifecycleButtons
 */
import { Archive, ArchiveRestore, Pause, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DeleteBoardDialog from './DeleteBoardDialog'
import WriteError from './WriteError'
import type { ReactNode } from 'react'
import type { BoardPatch, FeatureBoard } from '../../api/featureBoardsSchema'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

type Confirming = 'pause' | 'archive' | 'delete' | null

export interface BoardLifecycleButtonsProps {
  readonly board: FeatureBoard
  readonly api: Pick<FeatureRequestsApi, 'updateBoard' | 'deleteBoard'>
  /** Every button off (the editor holds unsaved changes). */
  readonly disabled?: boolean
  /** The buttons' classes (the card's ghost buttons, the editor's secondary ones). */
  readonly buttonClassName?: string
  /** After a pause, resume, archive or restore: the board as saved. */
  readonly onSaved: (saved: FeatureBoard) => Promise<void> | void
  /** After the board is gone. */
  readonly onDeleted: () => Promise<void> | void
}

function useBoardPatch(props: BoardLifecycleButtonsProps, close: () => void) {
  return useMutation({
    mutationFn: (patch: BoardPatch) => props.api.updateBoard(props.board.board_id, patch),
    onSuccess: async (saved) => {
      close()
      await props.onSaved(saved)
    },
  })
}

function LifecycleButton({ className, disabled, label, onClick, children }: Readonly<{
  className: string; disabled: boolean; label: string; onClick: () => void; children: ReactNode
}>) {
  return (
    <button type="button" className={className} disabled={disabled} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

/** The buttons of a board that is in use (not archived): Pause or Resume, and Archive. */
function ActiveBoardButtons({ board, className, busy, onPause, onResume, onArchive }: Readonly<{
  board: FeatureBoard; className: string; busy: boolean
  onPause: () => void; onResume: () => void; onArchive: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  return (
    <>
      {board.paused ? (
        <LifecycleButton className={className} disabled={busy} label={t('boards.lifecycle.resumeBoard', { name: board.name })} onClick={onResume}>
          <Play size={14} aria-hidden="true" />{t('boards.lifecycle.resume')}
        </LifecycleButton>
      ) : (
        <LifecycleButton className={className} disabled={busy} label={t('boards.lifecycle.pauseBoard', { name: board.name })} onClick={onPause}>
          <Pause size={14} aria-hidden="true" />{t('boards.lifecycle.pause')}
        </LifecycleButton>
      )}
      <LifecycleButton className={className} disabled={busy} label={t('boards.lifecycle.archiveBoard', { name: board.name })} onClick={onArchive}>
        <Archive size={14} aria-hidden="true" />{t('boards.lifecycle.archive')}
      </LifecycleButton>
    </>
  )
}

/** The buttons of an archived board: Restore, and Delete (the step archiving led to). */
function ArchivedBoardButtons({ board, className, busy, onRestore, onDelete }: Readonly<{
  board: FeatureBoard; className: string; busy: boolean; onRestore: () => void; onDelete: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  return (
    <>
      <LifecycleButton className={className} disabled={busy} label={t('boards.lifecycle.restoreBoard', { name: board.name })} onClick={onRestore}>
        <ArchiveRestore size={14} aria-hidden="true" />{t('boards.lifecycle.restore')}
      </LifecycleButton>
      <LifecycleButton className={`${className} text-danger`} disabled={busy} label={t('boards.deleteBoard', { name: board.name })} onClick={onDelete}>
        <Trash2 size={14} aria-hidden="true" />{t('actions.delete')}
      </LifecycleButton>
    </>
  )
}

/** What each asked-first step sends and says. */
const CONFIRMS = {
  pause: { patch: { paused: true }, titleKey: 'boards.lifecycle.pauseTitle', messageKey: 'boards.lifecycle.pauseMessage', labelKey: 'boards.lifecycle.pause' },
  archive: { patch: { archived: true }, titleKey: 'boards.lifecycle.archiveTitle', messageKey: 'boards.lifecycle.archiveMessage', labelKey: 'boards.lifecycle.archive' },
} as const satisfies Record<string, { patch: BoardPatch; titleKey: string; messageKey: string; labelKey: string }>

export default function BoardLifecycleButtons(props: Readonly<BoardLifecycleButtonsProps>) {
  const { board, api, disabled = false, buttonClassName = 'btn btn-ghost btn-sm', onDeleted } = props
  const { t } = useTranslation('featureRequests')
  const [confirming, setConfirming] = useState<Confirming>(null)
  const patch = useBoardPatch(props, () => setConfirming(null))
  const busy = disabled || patch.isPending
  const ask = (next: Confirming) => {
    patch.reset()
    setConfirming(next)
  }
  const confirmStep = confirming === 'pause' || confirming === 'archive' ? CONFIRMS[confirming] : null
  const afterDelete = async () => {
    setConfirming(null)
    await onDeleted()
  }
  return (
    <>
      {board.archived ? (
        <ArchivedBoardButtons board={board} className={buttonClassName} busy={busy}
          onRestore={() => patch.mutate({ archived: false })} onDelete={() => ask('delete')} />
      ) : (
        <ActiveBoardButtons board={board} className={buttonClassName} busy={busy}
          onPause={() => ask('pause')} onResume={() => patch.mutate({ paused: false })} onArchive={() => ask('archive')} />
      )}
      {confirming === null ? <WriteError error={patch.error} /> : null}
      {confirmStep === null ? null : (
        <ConfirmModal isOpen variant="warning" title={t(confirmStep.titleKey)}
          message={t(confirmStep.messageKey, { name: board.name })} confirmLabel={t(confirmStep.labelKey)}
          isLoading={patch.isPending} onConfirm={() => patch.mutate(confirmStep.patch)} onCancel={() => setConfirming(null)}>
          <WriteError error={patch.error} />
        </ConfirmModal>
      )}
      {confirming === 'delete'
        ? <DeleteBoardDialog board={board} api={api} onCancel={() => setConfirming(null)} onDeleted={afterDelete} />
        : null}
    </>
  )
}
