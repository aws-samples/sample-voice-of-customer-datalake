/**
 * @fileoverview App review plugin card components with run status display.
 * @module pages/Scrapers/AppConfigComponents
 */

import clsx from 'clsx'
import {
  Globe, Smartphone, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../utils/dateUtils'
import {
  WEB_REVIEWS_PLUGIN_ID, appField, getAppIdentifier, getFrequencyLabel,
} from './scraper-helpers'
import LearnedMethodLine from './LearnedMethodLine'
import ReviewReadLine from './ReviewReadLine'
import { readOfPage } from './reviewReads'
import { CardActions, CardStat, RadarBadge, RunStartedNotice } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'
import { isLiveRun } from './useAppRun'
import { AUTO_METHOD, reviewMethod, reviewPageDomain, showsReviewMethod } from './webReviewMethod'
import type { TargetRead } from './reviewReads'
import type { AppConfig } from './scraper-helpers'
import type { LearnedMethod } from './useLearnedMethods'
import type { ReviewMethod } from './webReviewMethod'
import type { PluginManifest } from '../../plugins/types'

export interface RunStatusInfo {
  status: string
  items_found: number
  errors: string[]
  started_at?: string
  completed_at?: string
  /** A web_reviews run: how it read each page (reviewReads.ts). */
  reads?: TargetRead[]
}

/** What kind of source a card is, in words (a web-review target is a "Review page", not "Platform: Web"). */
function kindLabelKey(pluginId: string): string {
  if (pluginId === 'app_reviews_ios') return 'appCard.kind.ios'
  if (pluginId === 'app_reviews_android') return 'appCard.kind.android'
  if (pluginId === WEB_REVIEWS_PLUGIN_ID) return 'appCard.kind.reviewPage'
  return 'appCard.kind.app'
}

/** Who a run of this card contacts, in words: the review page's site, or the app store. */
function useRunSite(app: AppConfig, pluginId: string): string {
  const { t } = useTranslation('scrapers')
  if (pluginId === 'app_reviews_ios') return t('card.siteAppStore')
  if (pluginId === 'app_reviews_android') return t('card.siteGooglePlay')
  const url = getAppIdentifier(app, pluginId)
  return reviewPageDomain(url) ?? (url === '' ? t('card.siteUnknown') : url)
}

/** A web_reviews target without `max_pages` reads this many (lambda/shared/web_review_targets.py DEFAULT_PAGES). */
const WEB_DEFAULT_PAGES = '10'

/** The per-run bounds a card shows: pages (and a review limit when set) for a web-review target, reviews for an app. */
function RunBoundStat({ app, pluginId }: Readonly<{ app: AppConfig; pluginId: string }>) {
  const { t } = useTranslation('scrapers')
  if (pluginId === WEB_REVIEWS_PLUGIN_ID) {
    const pages = appField(app, 'max_pages')
    const pagesValue = pages === '' ? WEB_DEFAULT_PAGES : pages
    const reviewLimit = appField(app, 'max_reviews')
    return (
      <>
        <CardStat label={t('appCard.maxPages')} value={pagesValue === '0' ? t('appCard.allPages') : pagesValue} mono />
        {reviewLimit === '' || reviewLimit === '0' ? null : <CardStat label={t('appCard.maxReviews')} value={reviewLimit} mono />}
      </>
    )
  }
  const reviews = appField(app, 'max_reviews_per_run')
  return <CardStat label={t('appCard.maxReviews')} value={reviews === '' ? '500' : reviews} mono />
}

/** Up to two run errors (a web target reports "<name>: blocked by <vendor>"), then how many more. */
const SHOWN_ERRORS = 2

/** The web_reviews ingestor's error for a site that refused the browser: `"<target>: blocked by <vendor>"`. */
const BLOCKED_ERROR = /: blocked by /

function RunErrors({ errors }: Readonly<{ errors: string[] }>) {
  const { t } = useTranslation('scrapers')
  if (errors.length === 0) return null
  return (
    <div className="mt-1 text-xs text-danger space-y-0.5">
      {errors.slice(0, SHOWN_ERRORS).map((error) => <div key={error} className="break-words [overflow-wrap:anywhere]">{error}</div>)}
      {errors.length > SHOWN_ERRORS ? <div>{t('status.moreErrors', { count: errors.length - SHOWN_ERRORS })}</div> : null}
      {/* What "blocked" means and where to read more (docs/web-reviews.md, "Blocked sites"). */}
      {errors.some((error) => BLOCKED_ERROR.test(error)) ? <p className="text-text">{t('status.blockedHint')}</p> : null}
    </div>
  )
}

/** What a run row says, for the card: `stale` is a `running` row that never finished (useAppRun STALE_RUN_MS). */
type ShownStatus = 'running' | 'stale' | 'error' | 'partial' | 'completed'

function shownStatus(status: RunStatusInfo): ShownStatus {
  if (status.status === 'running') return isLiveRun(status) ? 'running' : 'stale'
  if (status.status === 'error') return 'error'
  return status.errors.length > 0 ? 'partial' : 'completed'
}

const STATUS_COLOR: Readonly<Record<ShownStatus, string>> = {
  running: 'bg-info-subtle border-info/30',
  stale: 'bg-warn-subtle border-warn/30',
  error: 'bg-danger-subtle border-danger/30',
  partial: 'bg-warn-subtle border-warn/30',
  completed: 'bg-ok-subtle border-ok/30',
}

function StatusIcon({ shown }: Readonly<{ shown: ShownStatus }>) {
  const { t } = useTranslation('scrapers')
  switch (shown) {
    case 'running':
      return <><Loader2 size={14} className="animate-spin text-info" /><span className="font-medium text-info">{t('status.running')}</span></>
    case 'stale':
      return <><AlertCircle size={14} className="text-warn" /><span className="font-medium text-warn">{t('status.notFinished')}</span></>
    case 'error':
      return <><AlertCircle size={14} className="text-danger" /><span className="font-medium text-danger">{t('status.failed')}</span></>
    case 'partial':
      return <><AlertCircle size={14} className="text-warn" /><span className="font-medium text-warn">{t('status.completedWithErrors')}</span></>
    case 'completed':
      return <><CheckCircle2 size={14} className="text-ok" /><span className="font-medium text-ok">{t('status.completed')}</span></>
  }
}

/** When the shown run ran ("Last Run: 14 Oct 2026, 09:01"); nothing while it runs or when the row has no time. */
function RunWhen({ status, shown }: Readonly<{ status: RunStatusInfo; shown: ShownStatus }>) {
  const { t, i18n } = useTranslation('scrapers')
  const when = formatDateTime(status.completed_at ?? status.started_at, i18n.language)
  if (shown === 'running' || when === '') return null
  return <div className="text-xs text-muted">{t('card.lastRun')}: {when}</div>
}

function AppRunStatusBar({ status, appId }: Readonly<{ status: RunStatusInfo; appId: string }>) {
  const { t } = useTranslation('scrapers')
  const shown = shownStatus(status)
  const read = shown === 'running' ? undefined : readOfPage(status.reads, appId)
  return (
    <div className={clsx('mt-3 p-3 rounded-lg text-sm border', STATUS_COLOR[shown])}>
      <div className="flex items-center gap-2 mb-1">
        <StatusIcon shown={shown} />
      </div>
      <div className="text-xs text-text">
        {t('status.reviewsFound')} <span className="font-mono font-semibold text-text-strong">{status.items_found}</span>
      </div>
      {read === undefined ? null : <ReviewReadLine read={read} />}
      <RunWhen status={status} shown={shown} />
      {shown === 'running' ? <RunStartedNotice /> : null}
      <RunErrors errors={status.errors} />
    </div>
  )
}

/** Each method's badge on a review page's card. */
const METHOD_BADGE_KEYS: Readonly<Record<ReviewMethod, string>> = {
  auto: 'appCard.method.automatic',
  browser: 'appCard.method.browser',
  bedrock_web_search: 'appCard.method.bedrock',
}

/** "Automatic", "Browser" or "Bedrock web index": how a review page is read (webReviewMethod.ts). */
function ReviewMethodBadge({ app }: Readonly<{ app: AppConfig }>) {
  const { t } = useTranslation('scrapers')
  return <span className="badge badge-muted">{t(METHOD_BADGE_KEYS[reviewMethod(app)])}</span>
}

export function AppConfigCard({
  app, plugin, radarBrandLabel, isAdmin, onEdit, onDelete, onRun, isRunning, runStatus, learned,
}: Readonly<{
  app: AppConfig
  plugin: PluginManifest
  /** The label of the Radar brand the connector's `radar_brand` names (its reviews go to Radar), else undefined. */
  radarBrandLabel?: string
  /** Whether the current user is an admin. `POST /sources/{source}/run` and
   *  `DELETE /integrations/{source}/apps/{id}` are admin-gated server-side, so Run
   *  and Delete are disabled rather than allowed to fire a 403. Edit stays enabled:
   *  it opens `PluginConfigModal`, whose `AppEditorForm` Save button carries the
   *  gate for `POST /integrations/{source}/apps` — verified there, not assumed,
   *  because the equivalent claim about `ScraperEditor` turned out to be false. */
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  isRunning: boolean
  runStatus?: RunStatusInfo
  /** An Automatic review page's site: what this workspace learned for it, and Re-check (useLearnedMethods.ts). */
  learned?: LearnedMethod
}>) {
  const { t } = useTranslation('scrapers')
  const frequency = appField(app, 'frequency_minutes')
  const frequencyMinutes = Number.parseInt(frequency === '' ? '1440' : frequency, 10)
  const frequencyLabel = getFrequencyLabel(frequencyMinutes, t)
  const name = app.app_name === '' ? t('appCard.unnamed') : app.app_name
  const identifier = getAppIdentifier(app, plugin.id)
  const runSite = useRunSite(app, plugin.id)

  return (
    <div className="card">
      <div className="flex items-start gap-3 mb-4 min-w-0">
        <ToneTile icon={plugin.id === WEB_REVIEWS_PLUGIN_ID ? Globe : Smartphone} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-text-strong break-words [overflow-wrap:anywhere] min-w-0">{name}</h2>
            <RadarBadge brandLabel={radarBrandLabel} />
            {showsReviewMethod(app, plugin) ? <ReviewMethodBadge app={app} /> : null}
          </div>
          <p className="text-sm text-muted font-mono break-all">{identifier}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <CardStat label={t('card.frequency')} value={frequencyLabel} />
        <CardStat label={t('appCard.kindLabel')} value={t(kindLabelKey(plugin.id))} />
        <RunBoundStat app={app} pluginId={plugin.id} />
      </dl>
      {learned !== undefined && showsReviewMethod(app, plugin) && reviewMethod(app) === AUTO_METHOD
        ? <LearnedMethodLine learned={learned} isAdmin={isAdmin} /> : null}
      {runStatus == null ? null : <AppRunStatusBar status={runStatus} appId={appField(app, 'id')} />}
      <CardActions
        isAdmin={isAdmin}
        isRunning={isRunning}
        runDisabled={isRunning}
        runSite={runSite}
        onRun={onRun}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  )
}
