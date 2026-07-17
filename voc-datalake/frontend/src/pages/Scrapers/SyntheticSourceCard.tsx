/**
 * @fileoverview Persistent Data Sources card for synthetic generator plugins
 * (issue #146). Shows the persisted last run (status badge, items generated,
 * date) via api.getSourceRunStatus and opens GeneratorConfigModal to run.
 * @module pages/Scrapers/SyntheticSourceCard
 */

import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import {
  useCallback, useEffect, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { PluginManifest } from '../../plugins/types'

export interface SourceRunStatus {
  status: string
  started_at?: string
  completed_at?: string
  items_found?: number
  errors?: string[]
}

function getLastRunBadge(status: SourceRunStatus): {
  className: string;
  icon: string
} {
  if (status.status === 'completed' && (status.errors?.length ?? 0) === 0) return {
    className: 'bg-green-100 text-green-700',
    icon: '✓',
  }
  if (status.status === 'error' || status.status === 'failed') return {
    className: 'bg-red-100 text-red-700',
    icon: '✗',
  }
  return {
    className: 'bg-amber-100 text-amber-700',
    icon: '⚠',
  }
}

function LastRunSummary({ lastRun }: { readonly lastRun: SourceRunStatus }) {
  const { t } = useTranslation('scrapers')
  const badge = getLastRunBadge(lastRun)
  const when = lastRun.completed_at ?? lastRun.started_at
  const whenLabel = when != null && when !== '' ? new Date(when).toLocaleDateString() : t('card.never')
  return (
    <div className="mt-3 pt-3 border-t border-indigo-100 text-xs text-gray-500">
      <div className="flex items-center justify-between">
        <span>
          {t('syntheticCard.lastSummary', {
            items: lastRun.items_found ?? 0,
            date: whenLabel,
          })}
        </span>
        <span className={clsx('px-2 py-0.5 rounded', badge.className)}>{badge.icon}</span>
      </div>
      {(lastRun.errors?.length ?? 0) > 0 ? <p className="text-red-500 truncate mt-1">{lastRun.errors?.[0]}</p> : null}
    </div>
  )
}

/**
 * One card per synthetic generator plugin. The Generate button delegates to
 * the page, which opens the existing GeneratorConfigModal (no duplicated run
 * flow); `refreshToken` changes when that modal closes so the card re-fetches.
 */
export default function SyntheticSourceCard({
  plugin, onGenerate, refreshToken = 0,
}: {
  readonly plugin: PluginManifest
  readonly onGenerate: () => void
  readonly refreshToken?: number
}) {
  const { t } = useTranslation('scrapers')
  const [lastRun, setLastRun] = useState<SourceRunStatus | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const result = await api.getSourceRunStatus(plugin.id)
      // Wire-shape guard: only trust a real run record (string status that
      // isn't the never_run sentinel). Anything else renders the never-run
      // hint instead of a junk "0 items on Never" summary.
      if (typeof result.status === 'string' && result.status !== '' && result.status !== 'never_run') {
        setLastRun(result)
      }
    } catch {
      /* status is decorative — never break the card */
    }
  }, [plugin.id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount + modal close
    void fetchStatus()
  }, [fetchStatus, refreshToken])

  return (
    <div className="card border-2 border-indigo-200 bg-indigo-50/30 transition-all">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-xl">
            {plugin.icon.slice(0, 2)}
          </div>
          <div>
            <h3 className="font-semibold">{plugin.name}</h3>
            <p className="text-sm text-gray-500">{plugin.description}</p>
          </div>
        </div>
        <button
          onClick={onGenerate}
          className="btn btn-primary flex items-center gap-2 text-sm flex-shrink-0"
          title={t('syntheticCard.generate')}
        >
          <Sparkles size={16} /> {t('syntheticCard.generate')}
        </button>
      </div>
      {lastRun == null
        ? <p className="mt-3 pt-3 border-t border-indigo-100 text-xs text-gray-400">{t('syntheticCard.neverRun')}</p>
        : <LastRunSummary lastRun={lastRun} />}
    </div>
  )
}
