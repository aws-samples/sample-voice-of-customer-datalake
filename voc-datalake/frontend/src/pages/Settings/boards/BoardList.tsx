/**
 * @fileoverview Boards → the list of feedback boards (archived ones included, marked), each with its
 * template, audience, request count and an Edit button that opens the editor; plus "New board".
 * @module pages/Settings/boards/BoardList
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, Pencil, Plus } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { SettingsLoading } from '../SettingsNotice'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'
import { useAdminBoards } from './boardAdminQueries'
import { AUDIENCE_COPY, TEMPLATE_COPY } from './boardCopy'
import CreateBoardDialog from './CreateBoardDialog'

function BoardRow({ board, onOpen }: Readonly<{ board: FeatureBoard; onOpen: (boardId: string) => void }>) {
  const { t } = useTranslation('settings')
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text-strong break-words">{board.name}</span>
          {board.archived ? <span className="badge badge-muted">{t('boards.list.archived')}</span> : null}
        </div>
        <p className="text-xs text-muted">
          {t(TEMPLATE_COPY[board.template].labelKey)} · {t(AUDIENCE_COPY[board.audience.mode].labelKey)} ·{' '}
          {t('boards.list.requests', { count: board.request_count })}
        </p>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(board.board_id)}
        aria-label={t('boards.list.editLabel', { name: board.name })}>
        <Pencil size={14} aria-hidden="true" /> {t('boards.list.edit')}
      </button>
    </li>
  )
}

function ListBody({ onOpen }: Readonly<{ onOpen: (boardId: string) => void }>) {
  const { t } = useTranslation('settings')
  const boards = useAdminBoards()
  if (boards.isPending) return <SettingsLoading text={t('boards.loading')} />
  if (boards.isError) {
    return <LoadFailed message={t('boards.list.loadFailed')} onRetry={() => { void boards.refetch() }} retrying={boards.isFetching} />
  }
  if (boards.data.boards.length === 0) return <p className="text-sm text-muted">{t('boards.list.empty')}</p>
  return (
    <ul className="divide-y divide-border">
      {boards.data.boards.map((board) => <BoardRow key={board.board_id} board={board} onOpen={onOpen} />)}
    </ul>
  )
}

export default function BoardList({ onOpen }: Readonly<{ onOpen: (boardId: string) => void }>) {
  const { t } = useTranslation('settings')
  const [creating, setCreating] = useState(false)
  return (
    <section className="card space-y-3" aria-labelledby="board-list-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="board-list-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-strong">
            <Lightbulb className="text-accent" size={16} aria-hidden /> {t('boards.list.title')}
          </h2>
          <p className="text-sm text-muted">{t('boards.list.description')}</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> {t('boards.list.create')}
        </button>
      </div>
      <ListBody onOpen={onOpen} />
      {creating ? (
        <CreateBoardDialog onClose={() => setCreating(false)}
          onCreated={(board) => { setCreating(false); onOpen(board.board_id) }} />
      ) : null}
    </section>
  )
}
