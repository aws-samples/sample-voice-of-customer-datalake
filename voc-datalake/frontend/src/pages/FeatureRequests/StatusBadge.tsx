/** @fileoverview A request's status on its board, as a badge in the palette's status tints. */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { useCurrentBoard } from './boardContext'
import { boardStatusOf, statusLabel, statusTint } from './boardStatuses'

export default function StatusBadge({ status }: Readonly<{ status: string }>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  const shown = boardStatusOf(board, status)
  return <span className={clsx('badge', statusTint(board, shown.key))} data-testid="fr-status-badge">{statusLabel(shown, t)}</span>
}
