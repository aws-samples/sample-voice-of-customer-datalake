/**
 * @fileoverview Scraper logs panel for the Logs section.
 * @module pages/Settings/ScraperLogsPanel
 */

import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  RefreshCw, ChevronDown, Clock, Loader2, CheckCircle, XCircle, AlertTriangle,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { scrapersApi } from '../../api/scrapersApi'
import { formatTimestamp } from './logsHelpers'
import {
  LogsLoadingState, LogsEmptyState,
} from './logsUtils'

export function ScraperLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const {
    data: scrapersData, isLoading: loadingScrapers,
  } = useQuery({
    queryKey: ['scrapers'],
    queryFn: () => scrapersApi.getScrapers(),
  })

  if (loadingScrapers) {
    return <LogsLoadingState />
  }

  const scrapers = scrapersData?.scrapers ?? []

  if (scrapers.length === 0) {
    return <LogsEmptyState message={t('logs.noScrapersConfigured')} icon={RefreshCw} />
  }

  return (
    <div className="space-y-3">
      {scrapers.map((scraper) => (
        <ScraperLogCard key={scraper.id} scraperId={scraper.id} scraperName={scraper.name} days={days} />
      ))}
    </div>
  )
}

function ScraperLogCard({
  scraperId, scraperName, days,
}: {
  readonly scraperId: string;
  readonly scraperName: string;
  readonly days: number
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  const {
    data, isLoading,
  } = useQuery({
    queryKey: ['scraper-logs', scraperId, days],
    queryFn: () => api.getScraperLogs(scraperId, {
      days,
      limit: 10,
    }),
    enabled: isExpanded,
  })

  const logs = data?.logs ?? []

  return (
    <div className="card">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-gray-500" />
          <span className="font-medium">{scraperName}</span>
          {logs.length > 0 ? <ScraperStatusBadge status={logs[0].status} /> : null}
        </div>
        <ChevronDown size={16} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
      </button>

      {isExpanded ? <div className="mt-4 pt-4 border-t border-gray-100">
        <ScraperLogContent isLoading={isLoading} logs={logs} />
      </div> : null}
    </div>
  )
}

interface ScraperLogContentProps {
  readonly isLoading: boolean
  readonly logs: Array<{
    run_id: string;
    status: string;
    started_at: string;
    pages_scraped: number;
    items_found: number;
    errors: string[]
  }>
}

function ScraperLogContent({
  isLoading, logs,
}: ScraperLogContentProps) {
  const { t } = useTranslation('settings')

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={14} className="animate-spin" />
        {t('logs.loadingRuns')}
      </div>
    )
  }

  if (logs.length === 0) {
    return <p className="text-sm text-gray-500">{t('logs.noRunsInPeriod')}</p>
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div key={log.run_id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg text-sm">
          <div className="flex items-center gap-3">
            <ScraperStatusBadge status={log.status} />
            <span className="text-gray-600">{formatTimestamp(log.started_at, t)}</span>
          </div>
          <div className="flex items-center gap-4 text-gray-500">
            <span>{t('logs.pages', { count: log.pages_scraped })}</span>
            <span>{t('logs.items', { count: log.items_found })}</span>
            {log.errors.length > 0 && (
              <span className="text-red-600">{t('logs.runErrors', { count: log.errors.length })}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ScraperStatusBadge({ status }: { readonly status: string }) {
  const statusConfig: Record<string, {
    bg: string;
    text: string;
    icon: typeof CheckCircle
  }> = {
    completed: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: CheckCircle,
    },
    running: {
      bg: 'bg-blue-100',
      text: 'text-blue-700',
      icon: Loader2,
    },
    error: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      icon: XCircle,
    },
    completed_with_errors: {
      bg: 'bg-amber-100',
      text: 'text-amber-700',
      icon: AlertTriangle,
    },
  }

  const config = statusConfig[status] ?? {
    bg: 'bg-gray-100',
    text: 'text-gray-700',
    icon: Clock,
  }
  const StatusIcon = config.icon

  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full flex items-center gap-1', config.bg, config.text)}>
      <StatusIcon size={12} className={status === 'running' ? 'animate-spin' : ''} />
      {status.replaceAll('_', ' ')}
    </span>
  )
}
