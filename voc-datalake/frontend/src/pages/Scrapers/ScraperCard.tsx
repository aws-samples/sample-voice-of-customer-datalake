/**
 * @fileoverview Scraper card component with run status and polling.
 * @module pages/Scrapers/ScraperCard
 */

import { scraperAnchorId } from './scraperAnchor'
import clsx from 'clsx'
import {
  Globe, AlertCircle, CheckCircle, Loader2, XCircle,
} from 'lucide-react'
import {
  useState, useEffect, useCallback, type ReactElement,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { getFrequencyLabel, scheduleState } from './scraper-helpers'
import { formatDate } from '../../utils/dateUtils'
import type { ScraperConfig } from '../../api/types'
import { normalizedBaseUrl, scraperDomainLabel } from './scraperUrl'
import { CardActions, CardStat, RadarBadge, RunOutcomeBadge, RunStartedNotice, type RunOutcome } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'
import { noCleanup } from '../../hooks/noCleanup'

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
    if (!polling) return noCleanup

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
      {status.status === 'running' ? <RunStartedNotice /> : null}
      {hasErrors ? <div className="mt-2 text-xs text-danger">
        {status.errors.slice(0, 2).map((err) => <div key={err.slice(0, 50)} className="break-words [overflow-wrap:anywhere]">{err}</div>)}
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
      {lastRunInfo.errors.length > 0 && <p className="text-danger break-words [overflow-wrap:anywhere] mt-1">{lastRunInfo.errors[0]}</p>}
    </div>
  )
}

const SCHEDULE_STATE_KEYS = {
  scheduled: 'card.state.scheduled', manual: 'card.state.manual', paused: 'card.state.paused',
} as const

function ScraperCardHeader({
  scraper, radarBrandLabel,
}: {
  readonly scraper: ScraperConfig
  readonly radarBrandLabel: string | undefined
}) {
  const { t } = useTranslation('scrapers')
  const domain = scraperDomainLabel(scraper.base_url, t('card.notConfigured'))
  const state = scheduleState(scraper)
  return (
    <div className="flex items-start gap-3 mb-4 min-w-0">
      {/* The tile is a source (accent) like every other; `muted` is its one state, paused.
          Active is said once, by the badge beside the name, not painted twice. */}
      <ToneTile icon={Globe} tone={scraper.enabled ? 'accent' : 'muted'} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-text-strong break-words [overflow-wrap:anywhere] min-w-0">{scraper.name}</h2>
          {/* The schedule state, not "it exists": a manual-only scraper says Manual. */}
          <span className={clsx('badge flex-shrink-0', state === 'scheduled' ? 'badge-ok' : 'badge-muted')}>
            {t(SCHEDULE_STATE_KEYS[state])}
          </span>
          <RadarBadge brandLabel={radarBrandLabel} />
        </div>
        <p className="text-sm text-muted break-all">{domain}</p>
      </div>
    </div>
  )
}

/**
 * The card's action row. `POST /scrapers/{id}/run` and `DELETE /scrapers/{id}` are
 * admin-gated server-side, so those two controls are disabled for a non-admin rather
 * than issuing a request that 403s. Edit stays enabled so a non-admin can READ the
 * configuration: save (`POST /scrapers`) is admin-only too (it writes the shared
 * scraper credentials secret), so `ScraperEditor.tsx` opens read-only for them.
 */
function ScraperCardActions({
  scraper, isRunning, isAdmin, onRun, onEdit, onDelete,
}: {
  readonly scraper: ScraperConfig
  readonly isRunning: boolean
  readonly isAdmin: boolean
  readonly onRun: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('scrapers')
  const hasUrl = normalizedBaseUrl(scraper.base_url) !== ''
  return (
    <CardActions
      isAdmin={isAdmin}
      isRunning={isRunning}
      runDisabled={isRunning || !hasUrl}
      runSite={scraperDomainLabel(scraper.base_url, t('card.siteUnknown'))}
      onRun={onRun}
      onEdit={onEdit}
      onDelete={onDelete}
    />
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

function ScraperCardStats({
  scraper, lastRunInfo,
}: {
  readonly scraper: ScraperConfig;
  readonly lastRunInfo: RunStatus | null
}) {
  const { t, i18n } = useTranslation('scrapers')
  const totalUrls = calculateTotalUrls(scraper)
  const frequencyLabel = getFrequencyLabel(scraper.frequency_minutes, t)
  const lastRunDate = formatDate(lastRunInfo?.started_at, i18n.language, t('card.never'))

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
  scraper, radarBrandLabel, isAdmin, onEdit, onDelete, onRun,
}: {
  readonly scraper: ScraperConfig
  /** The label of the Radar brand `scraper.radar_brand` names (its reviews go to Radar), else undefined. */
  readonly radarBrandLabel?: string
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
    <div id={scraperAnchorId(scraper.id)} className="card scroll-mt-4">
      <ScraperCardHeader scraper={scraper} radarBrandLabel={radarBrandLabel} />
      <ScraperCardStats scraper={scraper} lastRunInfo={lastRunInfo} />
      {showLastRunSummary ? <LastRunSummary lastRunInfo={lastRunInfo} /> : null}
      {showStatus ? <ScraperRunStatus scraperId={scraper.id} onComplete={handleComplete} /> : null}
      <ScraperCardActions scraper={scraper} isRunning={isRunning} isAdmin={isAdmin} onRun={() => handleRun(onRun)} onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}
