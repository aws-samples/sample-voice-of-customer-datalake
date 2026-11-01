/**
 * @fileoverview One feedback board as a card: its name, template, who may use it, how many
 * requests it holds, Copy link (the board's share link) and Open; for an app admin also Edit (the
 * board editor in Administration) and BoardLifecycleButtons (Pause / Resume, Archive / Restore, and
 * Delete once archived).
 *
 * @module pages/FeatureRequests/BoardCard
 */
import { ArrowRight, Copy, Pencil } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { featureRequestKeys } from '../../api/featureRequestsApi'
import { formatCount } from '../../utils/numberFormat'
import BoardLifecycleButtons from './BoardLifecycleButtons'
import { boardEditorPath, boardPagePath, useBoardHost } from './boardContext'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import { AUDIENCE_LABELS, TEMPLATE_LABELS } from './boardLabels'

/** Who may use the board, in words; an admin also reads how many domains and people a list holds. */
function useAudienceText(board: FeatureBoard): string {
  const { t } = useTranslation('featureRequests')
  const { mode, domains, emails } = board.audience
  if (mode !== 'list' || (domains === undefined && emails === undefined)) return t(AUDIENCE_LABELS[mode].labelKey)
  return t('boards.audience.listCounts', {
    domains: t('boards.audience.listDomains', { count: domains?.length ?? 0 }),
    people: t('boards.audience.listPeople', { count: emails?.length ?? 0 }),
  })
}

function AdminActions({ board }: Readonly<{ board: FeatureBoard }>) {
  const { t } = useTranslation('featureRequests')
  const { api, session } = useBoardHost()
  const queryClient = useQueryClient()
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: featureRequestKeys.root(session) })
  }
  return (
    <>
      <Link className="btn btn-ghost btn-sm" to={boardEditorPath(board.board_id)} aria-label={t('boards.editBoard', { name: board.name })}>
        <Pencil size={14} aria-hidden="true" />{t('boards.edit')}
      </Link>
      <BoardLifecycleButtons board={board} api={api} onSaved={refresh} onDeleted={refresh} />
    </>
  )
}

export default function BoardCard({ board, isAdmin, onCopy }: Readonly<{
  board: FeatureBoard
  /** Edit / Delete (an app-pool admin only; the editor is in the app's Administration). */
  isAdmin: boolean
  onCopy: (url: string) => void
}>) {
  const { t, i18n } = useTranslation('featureRequests')
  const host = useBoardHost()
  const audience = useAudienceText(board)
  return (
    <li className="card p-4 space-y-3" data-testid={`board-card-${board.board_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-tight text-text-strong break-words">{board.name}</h2>
          {board.description === '' ? null : <p className="text-sm text-muted break-words">{board.description}</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <span className="badge badge-accent">{t(TEMPLATE_LABELS[board.template].labelKey)}</span>
          {board.archived ? <span className="badge badge-muted">{t('boards.archived')}</span> : null}
          {board.paused && !board.archived ? <span className="badge badge-warn">{t('boards.paused')}</span> : null}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div><dt className="text-muted">{t('boards.audienceLabel')}</dt><dd className="text-text break-words">{audience}</dd></div>
        <div>
          <dt className="text-muted">{t('boards.requestsLabel')}</dt>
          <dd className="text-text">{formatCount(board.request_count, i18n.language)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn btn-secondary btn-sm" to={boardPagePath(host, board.slug)} aria-label={t('boards.openBoard', { name: board.name })}>
          {t('boards.open')}<ArrowRight size={14} aria-hidden="true" />
        </Link>
        {board.share_url === '' ? null : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(board.share_url)}
            aria-label={t('boards.copyBoardLink', { name: board.name })}>
            <Copy size={14} aria-hidden="true" />{t('detail.copyLink')}
          </button>
        )}
        {isAdmin ? <AdminActions board={board} /> : null}
      </div>
    </li>
  )
}
