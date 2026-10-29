/**
 * @fileoverview One memory: its statement, kind / status / origin badges,
 * supporter count, and the actions the caller may take on it.
 *
 * Plain words only: a category id reads as its label, a stored id inside the
 * statement (a category, a source, a project) reads as its name
 * (`useLabelKnownIds`), and a statement the server partly hid for privacy says so.
 * A personal memory has no supporter count — the only supporter is you — so its
 * confirm reads "Still true" (it refreshes the memory against the 90-day decay).
 *
 * @module pages/Memory/MemoryCard
 */
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, Pencil, ShieldCheck, ThumbsUp, Users } from 'lucide-react'
import clsx from 'clsx'
import type { MemoryItem, MemorySourceKind, MemoryStatus } from '../../api/memoryApi'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { useLabelKnownIds } from '../../hooks/useLabelKnownIds'
import { formatDate } from '../../utils/dateUtils'
import { wasRedacted } from './privacyPreview'
import MemoryEditor from './MemoryEditor'
import type { MemoryEditing } from './MemoryEditor'

/** AI-written memories wear the `aim` tone (AI / generated content). */
const AUTOMATED_SOURCES: ReadonlySet<MemorySourceKind> = new Set(['extracted', 'agent'])

const STATUS_TONE: Record<MemoryStatus, string> = {
  active: 'badge-ok', proposed: 'badge-info', conflict: 'badge-warn', archived: 'badge-muted',
}

export interface MemoryActions {
  readonly onConfirm?: () => void
  /** The server did not count this caller's +1: they already back it (their own memory, or a second +1). */
  readonly alreadyBacked?: boolean
  /** Your own memory: confirming says it is still true rather than counting a +1. */
  readonly personal?: boolean
  readonly onEdit?: () => void
  readonly onForget?: () => void
  readonly onRestore?: () => void
  readonly onToggleSelect?: () => void
}

export function MemoryBadges({ memory }: Readonly<{ memory: MemoryItem }>) {
  const { t } = useTranslation('memory')
  const labels = useDisplayLabels()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={clsx('badge', STATUS_TONE[memory.status])}>{t(`status.${memory.status}`)}</span>
      <span className="badge badge-accent">{t(`kind.${memory.kind}`)}</span>
      <span className={clsx('badge', AUTOMATED_SOURCES.has(memory.source_kind) ? 'badge-aim' : 'badge-muted')}>
        {t(`source.${memory.source_kind}`)}
      </span>
      {memory.scope === 'company' ? (
        <span className="badge badge-muted flex items-center gap-1" title={t('supportersHint')}>
          <Users size={12} aria-hidden /> <span className="font-mono">{memory.supporters}</span>
          <span className="sr-only">{t('supportersHint')}</span>
        </span>
      ) : null}
      {memory.categories.map((c) => <span key={c} className="badge badge-muted">{labels.category(c)}</span>)}
    </div>
  )
}

/** "Since … · Long-term", with the lifetime explained in one sentence on hover and for screen readers. */
function MemoryMeta({ memory }: Readonly<{ memory: MemoryItem }>) {
  const { t, i18n } = useTranslation('memory')
  const hint = t(`retentionHint.${memory.retention}`)
  return (
    <p className="text-xs text-muted">
      {t('since', { created: formatDate(memory.created_at, i18n.language, '—') })}
      {' · '}
      <span title={hint} className="underline decoration-dotted underline-offset-2 cursor-help">{t(`retention.${memory.retention}`)}</span>
      <span className="sr-only"> — {hint}</span>
      {memory.expires_at ? ` · ${t('expires', { date: formatDate(memory.expires_at, i18n.language, '—') })}` : ''}
    </p>
  )
}

function ConfirmButton({ statement, actions }: Readonly<{ statement: string; actions: MemoryActions }>) {
  const { t } = useTranslation('memory')
  const personal = actions.personal === true
  const label = personal ? t('confirmPersonal') : t('confirm')
  const hint = personal ? t('confirmPersonalHint') : t('confirmHint')
  // Names the memory like Edit does, and starts with the visible label (5.35.03, e2e 5.35.02:
  // every card's button was announced as the same hint sentence).
  const name = personal ? t('confirmPersonalLabel', { statement }) : t('confirmLabel', { statement })
  if (actions.alreadyBacked === true) {
    // Said in words next to the control: a +1 that changed nothing used to look broken.
    const done = personal ? t('confirmedPersonal') : t('alreadyBacked')
    return (
      <span className="flex flex-col items-end gap-0.5">
        <button type="button" disabled className="btn btn-ghost btn-sm flex items-center gap-1" title={done}>
          <ThumbsUp size={14} aria-hidden /> {label}
        </button>
        <span role="status" className="text-xs text-muted text-right max-w-[14rem]">{done}</span>
      </span>
    )
  }
  return (
    <button type="button" onClick={actions.onConfirm} className="btn btn-ghost btn-sm flex items-center gap-1" title={hint} aria-label={name}>
      <ThumbsUp size={14} aria-hidden /> {label}
    </button>
  )
}

function MemoryCardActions({ memory, archived, actions }: Readonly<{ memory: MemoryItem; archived: boolean; actions: MemoryActions }>) {
  const { t } = useTranslation('memory')
  return (
    <div className="flex items-start gap-1">
      {actions.onConfirm && !archived ? <ConfirmButton statement={memory.statement.slice(0, 60)} actions={actions} /> : null}
      {actions.onEdit && !archived ? (
        <button type="button" onClick={actions.onEdit} className="icon-btn" title={t('edit')}
          aria-label={t('editLabel', { statement: memory.statement.slice(0, 60) })}>
          <Pencil size={16} aria-hidden />
        </button>
      ) : null}
      {actions.onForget && !archived ? (
        <button type="button" onClick={actions.onForget} className="icon-btn" aria-label={t('forget')} title={t('forget')}>
          <Archive size={16} aria-hidden />
        </button>
      ) : null}
      {actions.onRestore && archived ? (
        <button type="button" onClick={actions.onRestore} className="btn btn-ghost btn-sm flex items-center gap-1">
          <ArchiveRestore size={14} aria-hidden /> {t('restore')}
        </button>
      ) : null}
    </div>
  )
}

export default function MemoryCard({ memory, selected, actions, editing }: Readonly<{
  memory: MemoryItem
  selected: boolean
  actions: MemoryActions
  /** Set while this card's statement is being edited inline. */
  editing?: MemoryEditing
}>) {
  const { t } = useTranslation('memory')
  const labelIds = useLabelKnownIds()
  const archived = memory.status === 'archived'
  return (
    <li className={clsx('card p-4 flex gap-3', selected && 'bg-accent-subtle border-accent/40')} data-testid="memory-card">
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
        {editing ? <MemoryEditor statement={memory.statement} editing={editing} /> : (
          <p className={clsx('text-sm break-words', archived ? 'text-muted line-through' : 'text-text-strong')}>{labelIds(memory.statement)}</p>
        )}
        {wasRedacted(memory.statement) ? (
          <p className="text-xs text-muted flex items-center gap-1"><ShieldCheck size={12} aria-hidden /> {t('privacy.hidden')}</p>
        ) : null}
        <MemoryBadges memory={memory} />
        <MemoryMeta memory={memory} />
      </div>
      {editing ? null : <MemoryCardActions memory={memory} archived={archived} actions={actions} />}
    </li>
  )
}
