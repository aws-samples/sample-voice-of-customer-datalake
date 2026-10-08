/**
 * @fileoverview One memory: its statement, kind / status / origin badges,
 * supporter count, and the actions the caller may take on it.
 *
 * @module pages/Memory/MemoryCard
 */
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, ThumbsUp, Users } from 'lucide-react'
import clsx from 'clsx'
import type { MemoryItem, MemorySourceKind, MemoryStatus } from '../../api/memoryApi'

/** AI-written memories wear the `aim` tone (AI / generated content). */
const AUTOMATED_SOURCES: ReadonlySet<MemorySourceKind> = new Set(['extracted', 'agent'])

const STATUS_TONE: Record<MemoryStatus, string> = {
  active: 'badge-ok', proposed: 'badge-info', conflict: 'badge-warn', archived: 'badge-muted',
}

export interface MemoryActions {
  readonly onConfirm?: () => void
  readonly onForget?: () => void
  readonly onRestore?: () => void
  readonly onToggleSelect?: () => void
}

export function MemoryBadges({ memory }: Readonly<{ memory: MemoryItem }>) {
  const { t } = useTranslation('memory')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={clsx('badge', STATUS_TONE[memory.status])}>{t(`status.${memory.status}`)}</span>
      <span className="badge badge-accent">{t(`kind.${memory.kind}`)}</span>
      <span className={clsx('badge', AUTOMATED_SOURCES.has(memory.source_kind) ? 'badge-aim' : 'badge-muted')}>
        {t(`source.${memory.source_kind}`)}
      </span>
      <span className="badge badge-muted flex items-center gap-1" title={t('supportersHint')}>
        <Users size={12} /> <span className="font-mono">{memory.supporters}</span>
      </span>
      {memory.categories.map((c) => <span key={c} className="badge badge-muted">{c}</span>)}
    </div>
  )
}

export default function MemoryCard({ memory, selected, actions }: Readonly<{
  memory: MemoryItem
  selected: boolean
  actions: MemoryActions
}>) {
  const { t } = useTranslation('memory')
  const archived = memory.status === 'archived'
  return (
    <li className={clsx('card p-4 flex gap-3', selected && 'bg-accent-subtle border-accent/40')}>
      {actions.onToggleSelect ? (
        <input
          type="checkbox"
          className="accent-accent mt-1"
          checked={selected}
          onChange={actions.onToggleSelect}
          aria-label={t('selectForMerge', { statement: memory.statement.slice(0, 60) })}
        />
      ) : null}
      <div className="flex-1 min-w-0 space-y-2">
        <p className={clsx('text-sm', archived ? 'text-muted line-through' : 'text-text-strong')}>{memory.statement}</p>
        <MemoryBadges memory={memory} />
        <p className="text-xs text-muted">
          {t('meta', {
            created: memory.created_at ? new Date(memory.created_at).toLocaleDateString() : '—',
            retention: t(`retention.${memory.retention}`),
          })}
          {memory.expires_at ? ` · ${t('expires', { date: new Date(memory.expires_at).toLocaleDateString() })}` : ''}
        </p>
      </div>
      <div className="flex items-start gap-1">
        {actions.onConfirm && !archived ? (
          <button type="button" onClick={actions.onConfirm} className="btn btn-ghost btn-sm flex items-center gap-1" title={t('confirmHint')}>
            <ThumbsUp size={14} /> {t('confirm')}
          </button>
        ) : null}
        {actions.onForget && !archived ? (
          <button type="button" onClick={actions.onForget} className="icon-btn" aria-label={t('forget')} title={t('forget')}>
            <Archive size={16} />
          </button>
        ) : null}
        {actions.onRestore && archived ? (
          <button type="button" onClick={actions.onRestore} className="btn btn-ghost btn-sm flex items-center gap-1">
            <ArchiveRestore size={14} /> {t('restore')}
          </button>
        ) : null}
      </div>
    </li>
  )
}
