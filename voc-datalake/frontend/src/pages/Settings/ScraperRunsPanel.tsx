/**
 * @fileoverview Administration → System → Logs → Scraper runs: the custom
 * scrapers' run history and, beside them, the last run of each review-page and
 * app connector (Web Reviews, iOS, Android).
 *
 * Live finding: the tab said "No scrapers configured" while Web Reviews pages
 * existed and ran — their runs live on the source (`SOURCE_RUN#<plugin>`, read by
 * `GET /sources/status?run_status=<plugin>`), not on a scraper, so they never
 * showed. Each connector now has a card with its latest run.
 *
 * @module pages/Settings/ScraperRunsPanel
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, XCircle, RefreshCw, ChevronDown, Clock, Loader2, CheckCircle, Globe, Smartphone } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../api/client'
import { getPluginManifests } from '../../plugins'
import type { PluginManifest } from '../../plugins/types'
import { supportsAppConfigs, WEB_REVIEWS_PLUGIN_ID } from '../Scrapers/scraper-helpers'
import { formatTimestamp } from './logsFormat'
import { LogsEmptyState, LogsLoadingState } from './SourceLogList'

/** The deployed connectors whose runs are per source, not per scraper. */
function connectorPlugins(): PluginManifest[] {
  return getPluginManifests().filter((plugin) => plugin.enabled && supportsAppConfigs(plugin.id))
}

const CONNECTOR_KEYS: Readonly<Record<string, string>> = {
  [WEB_REVIEWS_PLUGIN_ID]: 'logs.connector.webReviews',
  app_reviews_ios: 'logs.connector.ios',
  app_reviews_android: 'logs.connector.android',
}

export default function ScraperLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const { data: scrapersData, isLoading: loadingScrapers } = useQuery({
    queryKey: ['scrapers'],
    queryFn: () => api.getScrapers(),
  })

  if (loadingScrapers) {
    return <LogsLoadingState />
  }

  const scrapers = scrapersData?.scrapers ?? []
  const connectors = connectorPlugins()

  if (scrapers.length === 0 && connectors.length === 0) {
    return <LogsEmptyState message={t('logs.noScrapersConfigured')} icon={RefreshCw} tone="muted" />
  }

  return (
    <div className="space-y-3">
      {scrapers.map(scraper => (
        <ScraperLogCard key={scraper.id} scraperId={scraper.id} scraperName={scraper.name} days={days} />
      ))}
      {connectors.length > 0 ? (
        <section aria-labelledby="connector-runs-heading" className="space-y-3 pt-2">
          <h3 id="connector-runs-heading" className="text-[0.6875rem] font-semibold uppercase tracking-[.08em] text-muted">{t('logs.connectorRuns')}</h3>
          {connectors.map((plugin) => <ConnectorRunCard key={plugin.id} plugin={plugin} />)}
        </section>
      ) : null}
    </div>
  )
}

/** A connector's latest run (all its pages / apps run together). */
function ConnectorRunCard({ plugin }: Readonly<{ plugin: PluginManifest }>) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery({
    queryKey: ['source-run-status', plugin.id],
    queryFn: () => api.getSourceRunStatus(plugin.id),
  })
  const key = CONNECTOR_KEYS[plugin.id]
  const name = key === undefined ? plugin.name : t(key)
  const Icon = plugin.id === WEB_REVIEWS_PLUGIN_ID ? Globe : Smartphone
  const ran = data?.started_at !== undefined && data.started_at !== ''
  return (
    <div className="card flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
        <span className="font-medium text-text-strong truncate">{name}</span>
        {ran ? <ScraperStatusBadge status={data.status} /> : null}
      </div>
      <ConnectorRunDetail isLoading={isLoading} run={ran ? data : undefined} />
    </div>
  )
}

function ConnectorRunDetail({ isLoading, run }: Readonly<{
  isLoading: boolean
  run: { started_at?: string; items_found?: number; errors?: string[] } | undefined
}>) {
  const { t, i18n } = useTranslation('settings')
  if (isLoading) return <Loader2 size={14} className="animate-spin text-muted" aria-label={t('logs.loadingRuns')} />
  if (run === undefined) return <span className="text-sm text-muted">{t('logs.noRunsYet')}</span>
  const errors = run.errors?.length ?? 0
  return (
    <div className="flex items-center gap-3 sm:gap-4 text-xs text-muted">
      <span className="text-text text-sm">{formatTimestamp(run.started_at ?? '', t, i18n.language)}</span>
      <span className="font-mono">{t('logs.items', { count: run.items_found ?? 0 })}</span>
      {errors > 0 ? <span className="text-danger font-mono">{t('logs.runErrors', { count: errors })}</span> : null}
    </div>
  )
}

function ScraperLogCard({ scraperId, scraperName, days }: { readonly scraperId: string; readonly scraperName: string; readonly days: number }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['scraper-logs', scraperId, days],
    queryFn: () => api.getScraperLogs(scraperId, { days, limit: 10 }),
    enabled: isExpanded,
  })

  const logs = data?.logs ?? []
  const latestRun = logs.at(0)

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="w-full flex items-center justify-between gap-2 text-left rounded-md focus-ring"
      >
        <div className="flex items-center gap-2 min-w-0">
          <RefreshCw size={16} className="text-muted flex-shrink-0" />
          <span className="font-medium text-text-strong truncate" title={scraperName}>{scraperName}</span>
          {latestRun && (
            <ScraperStatusBadge status={latestRun.status} />
          )}
        </div>
        <ChevronDown size={16} className={clsx('text-muted transition-transform', isExpanded && 'rotate-180')} />
      </button>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border">
          <ScraperLogContent isLoading={isLoading} logs={logs} />
        </div>
      )}
    </div>
  )
}

interface ScraperLogContentProps {
  readonly isLoading: boolean
  readonly logs: Array<{ run_id: string; status: string; started_at: string; pages_scraped: number; items_found: number; errors: string[] }>
}

function ScraperLogContent({ isLoading, logs }: ScraperLogContentProps) {
  const { t, i18n } = useTranslation('settings')
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" />
        {t('logs.loadingRuns')}
      </div>
    )
  }

  if (logs.length === 0) {
    return <p className="text-sm text-muted">{t('logs.noRunsInPeriod')}</p>
  }

  return (
    <div className="space-y-2">
      {logs.map(log => (
        <div key={log.run_id} className="flex flex-wrap items-center justify-between gap-2 p-2 bg-bg-accent rounded-lg text-sm">
          <div className="flex items-center gap-3">
            <ScraperStatusBadge status={log.status} />
            <span className="text-text">{formatTimestamp(log.started_at, t, i18n.language)}</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 text-muted font-mono text-xs">
            <span>{t('logs.pages', { count: log.pages_scraped })}</span>
            <span>{t('logs.items', { count: log.items_found })}</span>
            {log.errors.length > 0 && (
              <span className="text-danger">{t('logs.runErrors', { count: log.errors.length })}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ScraperStatusBadge({ status }: { readonly status: string }) {
  const statusConfig: Record<string, { badge: string; icon: typeof CheckCircle }> = {
    completed: { badge: 'badge-ok', icon: CheckCircle },
    running: { badge: 'badge-info', icon: Loader2 },
    error: { badge: 'badge-danger', icon: XCircle },
    completed_with_errors: { badge: 'badge-warn', icon: AlertTriangle },
  }

  const config = statusConfig[status] ?? { badge: 'badge-muted', icon: Clock }
  const Icon = config.icon

  return (
    <span className={clsx('badge flex items-center gap-1 flex-shrink-0', config.badge)}>
      <Icon size={12} className={status === 'running' ? 'animate-spin' : ''} />
      {status.replace(/_/g, ' ')}
    </span>
  )
}
