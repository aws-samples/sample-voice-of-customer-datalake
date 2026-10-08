/**
 * @fileoverview Scraper card component with run status and polling.
 * @module pages/Scrapers/ScraperCard
 */

import clsx from 'clsx'
import {
  Globe, AlertCircle, CheckCircle, Loader2, XCircle,
} from 'lucide-react'
import {
  useState, useEffect, useCallback, type ReactElement,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { FREQUENCY_OPTIONS } from './constants'
import type { ScraperConfig } from '../../api/types'
import { normalizedBaseUrl, scraperDomainLabel } from './scraperUrl'
import { CardActions, CardStat, RunOutcomeBadge, type RunOutcome } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'

interface RunStatus {
  status: string
  pages_scraped: number
  items_found: number
  errors: string[]
  started_at?: string
}

function getStatusStyle(status: RunStatus): string {
  if (status.status === 'running') return 'bg-info-subtle border-info/30'
  if (status.status === 'error') return 'bg-danger-subtle border-danger/30'
  if (status.errors.length > 0) return 'bg-warn-subtle border-warn/30'
  return 'bg-ok-subtle border-ok/30'
}

function StatusIndicator({ status }: { readonly status: RunStatus }): ReactElement | null {
  const { t } = useTranslation('scrapers')
  if (status.status === 'running') {
    return <><Loader2 size={16} className="animate-spin text-info" /><span className="font-medium text-info">{t('status.running')}</span></>
  }
  if (status.status === 'error') {
    return <><XCircle size={16} className="text-danger" /><span className="font-medium text-danger">{t('status.failed')}</span></>
  }
  if (status.errors.length > 0) {
    return <><AlertCircle size={16} className="text-warn" /><span className="font-medium text-warn">{t('status.completedWithErrors')}</span></>
  }
  return <><CheckCircle size={16} className="text-ok" /><span className="font-medium text-ok">{t('status.completed')}</span></>
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
      <div className="grid grid-cols-2 gap-2 text-xs text-text">
        <div>{t('status.pagesScraped')} <span className="font-mono font-semibold text-text-strong">{status.pages_scraped}</span></div>
        <div>{t('status.reviewsFound')} <span className="font-mono font-semibold text-text-strong">{status.items_found}</span></div>
      </div>
      {hasErrors ? <div className="mt-2 text-xs text-danger">
        {status.errors.slice(0, 2).map((err) => <div key={err.slice(0, 50)} className="truncate">{err}</div>)}
        {status.errors.length > 2 && <div>{t('status.moreErrors', { count: status.errors.length - 2 })}</div>}
      </div> : null}
    </div>
  )
}

function lastRunOutcome(status: string): RunOutcome {
  if (status === 'completed') return 'ok'
  if (status === 'error') return 'failed'
  return 'partial'
}

function LastRunSummary({ lastRunInfo }: { readonly lastRunInfo: RunStatus }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="mt-4 pt-3 border-t border-border text-xs text-muted">
      <div className="flex items-center justify-between gap-2">
        <span>{t('card.lastSummary', {
          pages: lastRunInfo.pages_scraped,
          reviews: lastRunInfo.items_found,
        })}</span>
        <RunOutcomeBadge outcome={lastRunOutcome(lastRunInfo.status)} />
      </div>
      {lastRunInfo.errors.length > 0 && <p className="text-danger truncate mt-1">{lastRunInfo.errors[0]}</p>}
    </div>
  )
}

function ScraperCardHeader({
  scraper, isRunning, isAdmin, onRun, onEdit, onDelete,
}: {
  readonly scraper: ScraperConfig
  readonly isRunning: boolean
  /** `POST /scrapers/{id}/run` and `DELETE /scrapers/{id}` are admin-gated
   *  server-side, so those two controls are disabled for a non-admin rather than
   *  issuing a request that 403s. Edit stays enabled: save (`POST /scrapers`) is
   *  open to every user by owner decision (2026-10-04), with only the schedule
   *  admin-only inside the editor (`ScraperEditor.tsx`). */
  readonly isAdmin: boolean
  readonly onRun: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('scrapers')
  const domain = scraperDomainLabel(scraper.base_url, t('card.notConfigured'))
  const hasUrl = normalizedBaseUrl(scraper.base_url) !== ''
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="flex items-center gap-3 min-w-0">
        <ToneTile icon={Globe} tone={scraper.enabled ? 'ok' : 'muted'} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-text-strong truncate" title={scraper.name}>{scraper.name}</h2>
            <span className={clsx('badge flex-shrink-0', scraper.enabled ? 'badge-ok' : 'badge-muted')}>
              {scraper.enabled ? t('card.active') : t('card.paused')}
            </span>
          </div>
          <p className="text-sm text-muted truncate" title={domain}>{domain}</p>
        </div>
      </div>
      <CardActions
        isAdmin={isAdmin}
        isRunning={isRunning}
        runDisabled={isRunning || !hasUrl}
        onRun={onRun}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  )
}

function calculateTotalUrls(scraper: ScraperConfig): number {
  // `urls` and `pagination` are normalized at the scrapersApi boundary (scrapersSchema.ts).
  const additionalUrls = scraper.urls.length
  const baseUrlCount = scraper.base_url ? 1 : 0
  const paginationCount = scraper.base_url && scraper.pagination.enabled
    ? scraper.pagination.max_pages - 1
    : 0
  return additionalUrls + baseUrlCount + paginationCount
}

function getFrequencyLabel(minutes: number): string {
  // Belt-and-braces for issue #169: the list normalizes at the API boundary,
  // but the card must stay render-safe standalone — a runtime-sparse record
  // used to render 'undefinedm' here.
  if (!Number.isFinite(minutes)) return '—'
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
    <dl className="grid grid-cols-3 gap-3 sm:gap-4">
      <CardStat label={t('card.frequency')} value={frequencyLabel} />
      <CardStat label={t('card.urls')} value={totalUrls} mono />
      <CardStat label={t('card.lastRun')} value={lastRunDate} />
    </dl>
  )
}

/** The scraper's latest run, or null when it never ran or the status cannot be read. */
async function loadLatestRun(scraperId: string): Promise<RunStatus | null> {
  try {
    const result = await scrapersApi.getScraperStatus(scraperId)
    return result.status === 'never_run' ? null : result
  } catch {
    return null
  }
}

function useScraperStatus(scraperId: string) {
  const [showStatus, setShowStatus] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRunInfo, setLastRunInfo] = useState<RunStatus | null>(null)

  // The state update lands in the promise callback, never synchronously in the effect.
  const fetchLatestStatus = useCallback(() => loadLatestRun(scraperId).then((info) => {
    if (info !== null) setLastRunInfo(info)
  }), [scraperId])

  useEffect(() => {
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
  scraper, isAdmin, onEdit, onDelete, onRun,
}: {
  readonly scraper: ScraperConfig
  /** See `ScraperCardHeader` — gates Run and Delete, whose routes require admin. */
  readonly isAdmin: boolean
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onRun: () => void
}) {
  const {
    showStatus, isRunning, lastRunInfo, handleRun, handleComplete,
  } = useScraperStatus(scraper.id)
  const showLastRunSummary = lastRunInfo != null && lastRunInfo.status !== 'never_run' && !showStatus

  return (
    // Paused is said by the badge and the muted icon tile — never by fading the
    // whole card, which pushed its text below AA contrast.
    <div className="card">
      <ScraperCardHeader scraper={scraper} isRunning={isRunning} isAdmin={isAdmin} onRun={() => handleRun(onRun)} onEdit={onEdit} onDelete={onDelete} />
      <ScraperCardStats scraper={scraper} lastRunInfo={lastRunInfo} />
      {showLastRunSummary ? <LastRunSummary lastRunInfo={lastRunInfo} /> : null}
      {showStatus ? <ScraperRunStatus scraperId={scraper.id} onComplete={handleComplete} /> : null}
    </div>
  )
}
