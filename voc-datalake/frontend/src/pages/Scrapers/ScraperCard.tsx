/**
 * @fileoverview Scraper card component with run status and polling.
 * @module pages/Scrapers/ScraperCard
 */

import clsx from 'clsx'
import {
  Play, Trash2, Settings, Globe, AlertCircle, CheckCircle, Loader2, XCircle,
} from 'lucide-react'
import {
  useState, useEffect, useCallback, type ReactElement,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { FREQUENCY_OPTIONS } from './constants'
import type { ScraperConfig } from '../../api/types'

interface RunStatus {
  status: string
  pages_scraped: number
  items_found: number
  errors: string[]
  started_at?: string
}

function getStatusStyle(status: RunStatus): string {
  if (status.status === 'running') return 'bg-blue-50 border-blue-200'
  if (status.status === 'error') return 'bg-red-50 border-red-200'
  if (status.errors.length > 0) return 'bg-amber-50 border-amber-200'
  return 'bg-green-50 border-green-200'
}

function StatusIndicator({ status }: { readonly status: RunStatus }): ReactElement | null {
  const { t } = useTranslation('scrapers')
  if (status.status === 'running') {
    return <><Loader2 size={16} className="animate-spin text-blue-600" /><span className="font-medium text-blue-700">{t('status.running')}</span></>
  }
  if (status.status === 'error') {
    return <><XCircle size={16} className="text-red-600" /><span className="font-medium text-red-700">{t('status.failed')}</span></>
  }
  if (status.errors.length > 0) {
    return <><AlertCircle size={16} className="text-amber-600" /><span className="font-medium text-amber-700">{t('status.completedWithErrors')}</span></>
  }
  return <><CheckCircle size={16} className="text-green-600" /><span className="font-medium text-green-700">{t('status.completed')}</span></>
}

function ScraperRunStatus({
  scraperId, onComplete,
}: {
  readonly scraperId: string;
  readonly onComplete?: () => void
}) {
  const { t } = useTranslation('scrapers')
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!polling) return

    const poll = async () => {
      try {
        const result = await scrapersApi.getScraperStatus(scraperId)
        setStatus(result)
        if (['completed', 'completed_with_errors', 'error'].includes(result.status)) {
          setPolling(false)
          onComplete?.()
        }
      } catch {
        // Ignore polling errors
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), 2000)
    return () => clearInterval(interval)
  }, [scraperId, polling, onComplete])

  if (status == null || status.status === 'never_run') return null

  const hasErrors = status.errors.length > 0

  return (
    <div className={clsx('mt-3 p-3 rounded-lg text-sm border', getStatusStyle(status))}>
      <div className="flex items-center gap-2 mb-2">
        <StatusIndicator status={status} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>{t('status.pagesScraped')} <span className="font-semibold">{status.pages_scraped}</span></div>
        <div>{t('status.reviewsFound')} <span className="font-semibold">{status.items_found}</span></div>
      </div>
      {hasErrors ? <div className="mt-2 text-xs text-red-600">
        {status.errors.slice(0, 2).map((err) => <div key={err.slice(0, 50)} className="truncate">{err}</div>)}
        {status.errors.length > 2 && <div>{t('status.moreErrors', { count: status.errors.length - 2 })}</div>}
      </div> : null}
    </div>
  )
}

function getLastRunBadge(status: string): {
  className: string;
  icon: string
} {
  if (status === 'completed') return {
    className: 'bg-green-100 text-green-700',
    icon: '✓',
  }
  if (status === 'error') return {
    className: 'bg-red-100 text-red-700',
    icon: '✗',
  }
  return {
    className: 'bg-amber-100 text-amber-700',
    icon: '⚠',
  }
}

function LastRunSummary({ lastRunInfo }: { readonly lastRunInfo: RunStatus }) {
  const { t } = useTranslation('scrapers')
  const badge = getLastRunBadge(lastRunInfo.status)
  return (
    <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
      <div className="flex items-center justify-between">
        <span>{t('card.lastSummary', {
          pages: lastRunInfo.pages_scraped,
          reviews: lastRunInfo.items_found,
        })}</span>
        <span className={clsx('px-2 py-0.5 rounded', badge.className)}>{badge.icon}</span>
      </div>
      {lastRunInfo.errors.length > 0 && <p className="text-red-500 truncate mt-1">{lastRunInfo.errors[0]}</p>}
    </div>
  )
}

function ScraperCardHeader({
  scraper, isRunning, onRun, onEdit, onDelete,
}: {
  readonly scraper: ScraperConfig
  readonly isRunning: boolean
  readonly onRun: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('scrapers')
  const domain = scraper.base_url === '' ? t('card.notConfigured') : new URL(scraper.base_url).hostname
  return (
    <div className="flex items-start justify-between mb-3">
      <div className="flex items-center gap-3">
        <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center', scraper.enabled ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400')}>
          <Globe size={20} />
        </div>
        <div>
          <h3 className="font-semibold">{scraper.name}</h3>
          <p className="text-sm text-gray-500">{domain}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onRun} disabled={isRunning || scraper.base_url === ''} className={clsx('p-2 rounded transition-colors', isRunning ? 'bg-blue-100 text-blue-600' : 'hover:bg-green-100 text-green-600')} title={t('card.runNow')}>
          {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        </button>
        <button onClick={onEdit} className="p-2 hover:bg-gray-100 rounded" title={t('card.edit')}><Settings size={16} /></button>
        <button onClick={onDelete} className="p-2 hover:bg-gray-100 rounded text-red-500" title={t('card.delete')}><Trash2 size={16} /></button>
      </div>
    </div>
  )
}

function calculateTotalUrls(scraper: ScraperConfig): number {
  const additionalUrls = scraper.urls.length
  const baseUrlCount = scraper.base_url === '' ? 0 : 1
  const paginationCount = scraper.base_url !== '' && scraper.pagination.enabled
    ? scraper.pagination.max_pages - 1
    : 0
  return additionalUrls + baseUrlCount + paginationCount
}

function getFrequencyLabel(minutes: number): string {
  return FREQUENCY_OPTIONS.find((f) => f.value === minutes)?.label ?? `${minutes}m`
}

function ScraperCardStats({
  scraper, lastRunInfo,
}: {
  readonly scraper: ScraperConfig;
  readonly lastRunInfo: RunStatus | null
}) {
  const { t } = useTranslation('scrapers')
  const totalUrls = calculateTotalUrls(scraper)
  const frequencyLabel = getFrequencyLabel(scraper.frequency_minutes)
  const lastRunDate = lastRunInfo?.started_at != null && lastRunInfo.started_at !== '' ? new Date(lastRunInfo.started_at).toLocaleDateString() : t('card.never')

  return (
    <div className="grid grid-cols-3 gap-4 text-sm">
      <div><span className="text-gray-500">{t('card.frequency')}</span><p className="font-medium">{frequencyLabel}</p></div>
      <div><span className="text-gray-500">{t('card.urls')}</span><p className="font-medium">{totalUrls}</p></div>
      <div><span className="text-gray-500">{t('card.lastRun')}</span><p className="font-medium">{lastRunDate}</p></div>
    </div>
  )
}

function useScraperStatus(scraperId: string) {
  const [showStatus, setShowStatus] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRunInfo, setLastRunInfo] = useState<RunStatus | null>(null)

  const fetchLatestStatus = useCallback(async () => {
    try {
      const result = await scrapersApi.getScraperStatus(scraperId)
      if (result.status !== 'never_run') setLastRunInfo(result)
    } catch {
      /* ignore */
    }
  }, [scraperId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    void fetchLatestStatus()
  }, [fetchLatestStatus])

  const handleRun = (onRun: () => void) => {
    setIsRunning(true)
    setShowStatus(true)
    onRun()
  }

  const handleComplete = () => {
    setIsRunning(false)
    void fetchLatestStatus()
  }

  return {
    showStatus,
    isRunning,
    lastRunInfo,
    handleRun,
    handleComplete,
  }
}

export default function ScraperCard({
  scraper, onEdit, onDelete, onRun,
}: {
  readonly scraper: ScraperConfig
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onRun: () => void
}) {
  const {
    showStatus, isRunning, lastRunInfo, handleRun, handleComplete,
  } = useScraperStatus(scraper.id)
  const showLastRunSummary = lastRunInfo != null && lastRunInfo.status !== 'never_run' && !showStatus

  return (
    <div className={clsx('card border-2 transition-all', scraper.enabled ? 'border-green-200 bg-green-50/30' : 'border-gray-200 opacity-60')}>
      <ScraperCardHeader scraper={scraper} isRunning={isRunning} onRun={() => handleRun(onRun)} onEdit={onEdit} onDelete={onDelete} />
      <ScraperCardStats scraper={scraper} lastRunInfo={lastRunInfo} />
      {showLastRunSummary ? <LastRunSummary lastRunInfo={lastRunInfo} /> : null}
      {showStatus ? <ScraperRunStatus scraperId={scraper.id} onComplete={handleComplete} /> : null}
    </div>
  )
}
