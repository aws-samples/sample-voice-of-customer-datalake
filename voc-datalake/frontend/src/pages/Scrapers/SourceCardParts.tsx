/**
 * @fileoverview Pieces shared by the data-source cards (web scraper, app review):
 * the Run / Edit / Delete icon toolbar and the label-over-value stat.
 *
 * Both cards rendered these by hand with slightly different markup — unlabelled
 * icon buttons, `opacity-50` stacked on `disabled:` styles, a muted Edit icon on
 * one card and an inherited one on the other.
 * @module pages/Scrapers/SourceCardParts
 */

import clsx from 'clsx'
import { AlertCircle, CheckCircle2, Loader2, Play, Settings, Trash2, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'

export function CardStat({ label, value, mono = false }: Readonly<{ label: string; value: ReactNode; mono?: boolean }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={clsx('text-sm font-medium text-text-strong truncate', mono && 'font-mono')} title={typeof value === 'string' ? value : undefined}>{value}</dd>
    </div>
  )
}

/**
 * Run and Delete are admin-gated server-side, so they are disabled (with the
 * admin-only title) for a non-admin. Edit always stays enabled — see the card
 * components for why that is safe. The accessible NAME stays the action; the
 * title carries the reason it is unavailable.
 */
export function CardActions({
  isAdmin, isRunning, runDisabled, onRun, onEdit, onDelete,
}: Readonly<{
  isAdmin: boolean
  isRunning: boolean
  runDisabled: boolean
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
}>) {
  const { t } = useTranslation('scrapers')
  const labels = { run: t('card.runNow'), edit: t('card.edit'), delete: t('card.delete') }
  return (
    <div className="flex items-center flex-shrink-0 -mr-1.5 -mt-1">
      <button
        type="button"
        onClick={onRun}
        disabled={runDisabled || !isAdmin}
        aria-label={labels.run}
        title={isAdmin ? labels.run : ADMIN_ONLY_TITLE}
        className={clsx('icon-btn p-2 disabled:opacity-40 disabled:cursor-not-allowed', isRunning ? 'text-info' : 'hover:text-ok')}
      >
        {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
      </button>
      <button type="button" onClick={onEdit} aria-label={labels.edit} title={labels.edit} className="icon-btn p-2">
        <Settings size={16} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!isAdmin}
        aria-label={labels.delete}
        title={isAdmin ? labels.delete : ADMIN_ONLY_TITLE}
        className="icon-btn p-2 hover:text-danger hover:bg-danger-subtle disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}

export type RunOutcome = 'ok' | 'failed' | 'partial'

const OUTCOME = {
  ok: { badge: 'badge-ok', icon: CheckCircle2, labelKey: 'status.completed' },
  failed: { badge: 'badge-danger', icon: XCircle, labelKey: 'status.failed' },
  partial: { badge: 'badge-warn', icon: AlertCircle, labelKey: 'status.completedWithErrors' },
} as const

/**
 * Outcome of a source's last run: tone + icon + a word, so colour is never the
 * only signal (the cards used to show a bare ✓ / ✗ / ⚠ glyph in a tinted box).
 */
export function RunOutcomeBadge({ outcome }: Readonly<{ outcome: RunOutcome }>) {
  const { t } = useTranslation('scrapers')
  const { badge, icon: Icon, labelKey } = OUTCOME[outcome]
  return (
    <span className={clsx('badge inline-flex items-center gap-1 flex-shrink-0', badge)}>
      <Icon size={12} aria-hidden="true" />{t(labelKey)}
    </span>
  )
}
