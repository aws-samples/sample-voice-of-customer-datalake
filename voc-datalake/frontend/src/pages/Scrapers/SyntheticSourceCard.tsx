/**
 * @fileoverview Persistent Data Sources card for synthetic generator plugins
 * (issue #146). Shows the persisted last run (status badge, items generated,
 * date) via api.getSourceRunStatus and opens GeneratorConfigModal to run.
 *
 * Data flow follows the repo patterns: TanStack Query for fetching (the page
 * invalidates ['source-run-status'] when the generator modal closes) and a
 * lenient Zod schema at the wire boundary (./sourceRunStatus).
 *
 * @module pages/Scrapers/SyntheticSourceCard
 */

import { useQuery } from '@tanstack/react-query'
import { FlaskConical, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { RunOutcomeBadge, type RunOutcome } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'
import { parseRunRecord } from './sourceRunStatus'
import type { SourceRunStatus } from './sourceRunStatus'
import type { PluginManifest } from '../../plugins/types'

function lastRunOutcome(status: SourceRunStatus): RunOutcome {
  if (status.status === 'completed' && (status.errors?.length ?? 0) === 0) return 'ok'
  if (status.status === 'error' || status.status === 'failed') return 'failed'
  return 'partial'
}

function LastRunSummary({ lastRun }: { readonly lastRun: SourceRunStatus }) {
  const { t } = useTranslation('scrapers')
  const when = lastRun.completed_at ?? lastRun.started_at
  const whenLabel = when != null && when !== '' ? new Date(when).toLocaleDateString() : t('card.never')
  return (
    <div className="mt-4 pt-3 border-t border-border text-xs text-muted">
      <div className="flex items-center justify-between gap-2">
        <span>
          {t('syntheticCard.lastSummary', {
            items: lastRun.items_found ?? 0,
            date: whenLabel,
          })}
        </span>
        <RunOutcomeBadge outcome={lastRunOutcome(lastRun)} />
      </div>
      {(lastRun.errors?.length ?? 0) > 0 ? <p className="text-danger truncate mt-1">{lastRun.errors?.[0]}</p> : null}
    </div>
  )
}

/**
 * One card per synthetic generator plugin. The Generate button delegates to
 * the page, which opens the existing GeneratorConfigModal (no duplicated run
 * flow) and invalidates the ['source-run-status'] queries when it closes.
 *
 * The manifest's emoji icon is not rendered: the design system bans emoji as
 * icons, and every generator is the same kind of source, so one lucide glyph in
 * the `aim` (AI-generated) tone identifies it.
 */
export default function SyntheticSourceCard({
  plugin, onGenerate,
}: {
  readonly plugin: PluginManifest
  readonly onGenerate: () => void
}) {
  const { t } = useTranslation('scrapers')

  const { data } = useQuery({
    queryKey: ['source-run-status', plugin.id],
    queryFn: () => api.getSourceRunStatus(plugin.id),
  })
  const lastRun = data === undefined ? null : parseRunRecord(data)

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <ToneTile icon={FlaskConical} tone="aim" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-text-strong">{plugin.name}</h3>
            <p className="text-sm text-muted mt-0.5">{plugin.description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          className="btn btn-secondary justify-center flex-shrink-0"
        >
          <Sparkles size={16} className="text-aim" /> {t('syntheticCard.generate')}
        </button>
      </div>
      {lastRun == null
        ? <p className="mt-4 pt-3 border-t border-border text-xs text-muted">{t('syntheticCard.neverRun')}</p>
        : <LastRunSummary lastRun={lastRun} />}
    </div>
  )
}
