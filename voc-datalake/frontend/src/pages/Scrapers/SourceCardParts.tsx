/**
 * @fileoverview Pieces shared by the data-source cards (web scraper, app review):
 * the Run / Edit / Delete icon toolbar, the label-over-value stat and the Radar badge.
 *
 * Both cards rendered these by hand with slightly different markup — unlabelled
 * icon buttons, `opacity-50` stacked on `disabled:` styles, a muted Edit icon on
 * one card and an inherited one on the other.
 * @module pages/Scrapers/SourceCardParts
 */

import clsx from 'clsx'
import { AlertCircle, CheckCircle2, Loader2, Play, Settings, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'

/** The muted "Radar: <brand>" badge of a source whose reviews go to Radar; nothing for an ordinary source. */
export function RadarBadge({ brandLabel }: Readonly<{ brandLabel: string | undefined }>) {
  const { t } = useTranslation('scrapers')
  if (brandLabel === undefined) return null
  return <span className="badge badge-muted break-words [overflow-wrap:anywhere]" title={brandLabel}>{t('card.radarBadge', { brand: brandLabel })}</span>
}

export function CardStat({ label, value, mono = false }: Readonly<{ label: string; value: ReactNode; mono?: boolean }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={clsx('text-sm font-medium text-text-strong break-words [overflow-wrap:anywhere]', mono && 'font-mono')}>{value}</dd>
    </div>
  )
}

/**
 * The card's action row (its footer): a labelled "Run now" button, then Edit and
 * Remove as icon buttons with a tooltip and an accessible name.
 *
 * Run starts a real fetch that contacts `runSite` and adds reviews, so it asks
 * first (ConfirmModal) — it used to start in one click from an unlabelled play
 * icon. Run and Delete are admin-gated server-side, so they are disabled (with
 * the admin-only title) for a non-admin. Edit always stays enabled — see the card
 * components for why that is safe. The accessible NAME stays the action; the
 * title carries the reason it is unavailable.
 */
export function CardActions({
  isAdmin, isRunning, runDisabled, runSite, onRun, onEdit, onDelete,
}: Readonly<{
  isAdmin: boolean
  isRunning: boolean
  runDisabled: boolean
  /** Who a run contacts, in words ("trustpilot.com", "the App Store"), for the confirmation. */
  runSite: string
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
}>) {
  const { t } = useTranslation('scrapers')
  const [confirming, setConfirming] = useState(false)
  const labels = { run: t('card.runNow'), edit: t('card.edit'), delete: t('card.delete') }
  return (
    <div className="mt-4 pt-3 border-t border-border flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={runDisabled || !isAdmin}
        title={isAdmin ? labels.run : ADMIN_ONLY_TITLE}
        className="btn btn-secondary btn-sm inline-flex items-center gap-1.5 disabled:cursor-not-allowed"
      >
        {isRunning ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {isRunning ? t('status.running') : labels.run}
      </button>
      <span className="flex-1" />
      <button type="button" onClick={onEdit} aria-label={labels.edit} title={labels.edit} className="icon-btn p-2">
        <Settings size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!isAdmin}
        aria-label={labels.delete}
        title={isAdmin ? labels.delete : ADMIN_ONLY_TITLE}
        className="icon-btn p-2 hover:text-danger hover:bg-danger-subtle disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
      <ConfirmModal
        isOpen={confirming}
        variant="info"
        title={t('card.runConfirmTitle')}
        message={t('card.runConfirmMessage', { site: runSite })}
        confirmLabel={t('card.runConfirmLabel')}
        onConfirm={() => { setConfirming(false); onRun() }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}

/** "Started — new reviews show up here when it finishes": said right after a run starts. */
export function RunStartedNotice() {
  const { t } = useTranslation('scrapers')
  return <p role="status" className="mt-1 text-xs text-text">{t('card.runStarted')}</p>
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
