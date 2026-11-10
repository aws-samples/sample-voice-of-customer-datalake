/**
 * @fileoverview App review plugin card components with run status display.
 * @module pages/Scrapers/AppConfigComponents
 */

import clsx from 'clsx'
import {
  Globe, Smartphone, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  WEB_REVIEWS_PLUGIN_ID, appField, getAppIdentifier, getFrequencyLabel,
} from './scraper-helpers'
import { CardActions, CardStat, RadarBadge, RunStartedNotice } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

export interface RunStatusInfo {
  status: string
  items_found: number
  errors: string[]
}

/** What kind of source a card is, in words (a web-review target is a "Review page", not "Platform: Web"). */
function kindLabelKey(pluginId: string): string {
  if (pluginId === 'app_reviews_ios') return 'appCard.kind.ios'
  if (pluginId === 'app_reviews_android') return 'appCard.kind.android'
  if (pluginId === WEB_REVIEWS_PLUGIN_ID) return 'appCard.kind.reviewPage'
  return 'appCard.kind.app'
}

/** A web-review page's host without `www.` ("trustpilot.com"); undefined when the URL does not parse. */
function reviewPageHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** Who a run of this card contacts, in words: the review page's site, or the app store. */
function useRunSite(app: AppConfig, pluginId: string): string {
  const { t } = useTranslation('scrapers')
  if (pluginId === 'app_reviews_ios') return t('card.siteAppStore')
  if (pluginId === 'app_reviews_android') return t('card.siteGooglePlay')
  const url = getAppIdentifier(app, pluginId)
  return reviewPageHost(url) ?? (url === '' ? t('card.siteUnknown') : url)
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

function RunErrors({ errors }: Readonly<{ errors: string[] }>) {
  const { t } = useTranslation('scrapers')
  if (errors.length === 0) return null
  return (
    <div className="mt-1 text-xs text-danger space-y-0.5">
      {errors.slice(0, SHOWN_ERRORS).map((error) => <div key={error} className="break-words [overflow-wrap:anywhere]">{error}</div>)}
      {errors.length > SHOWN_ERRORS ? <div>{t('status.moreErrors', { count: errors.length - SHOWN_ERRORS })}</div> : null}
    </div>
  )
}

function getStatusColor(status: string, hasErrors: boolean): string {
  if (status === 'running') return 'bg-info-subtle border-info/30'
  if (status === 'error') return 'bg-danger-subtle border-danger/30'
  if (hasErrors) return 'bg-warn-subtle border-warn/30'
  return 'bg-ok-subtle border-ok/30'
}

function StatusIcon({
  status, hasErrors,
}: Readonly<{
  status: string
  hasErrors: boolean
}>) {
  const { t } = useTranslation('scrapers')
  if (status === 'running') {
    return <><Loader2 size={14} className="animate-spin text-info" /><span className="font-medium text-info">{t('status.running')}</span></>
  }
  if (status === 'error') {
    return <><AlertCircle size={14} className="text-danger" /><span className="font-medium text-danger">{t('status.failed')}</span></>
  }
  if (hasErrors) {
    return <><AlertCircle size={14} className="text-warn" /><span className="font-medium text-warn">{t('status.completedWithErrors')}</span></>
  }
  return <><CheckCircle2 size={14} className="text-ok" /><span className="font-medium text-ok">{t('status.completed')}</span></>
}

function AppRunStatusBar({ status }: Readonly<{ status: RunStatusInfo }>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className={clsx('mt-3 p-3 rounded-lg text-sm border', getStatusColor(status.status, status.errors.length > 0))}>
      <div className="flex items-center gap-2 mb-1">
        <StatusIcon status={status.status} hasErrors={status.errors.length > 0} />
      </div>
      <div className="text-xs text-text">
        {t('status.reviewsFound')} <span className="font-mono font-semibold text-text-strong">{status.items_found}</span>
      </div>
      {status.status === 'running' ? <RunStartedNotice /> : null}
      <RunErrors errors={status.errors} />
    </div>
  )
}

export function AppConfigCard({
  app, plugin, radarBrandLabel, isAdmin, onEdit, onDelete, onRun, isRunning, runStatus,
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
          </div>
          <p className="text-sm text-muted font-mono break-all">{identifier}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <CardStat label={t('card.frequency')} value={frequencyLabel} />
        <CardStat label={t('appCard.kindLabel')} value={t(kindLabelKey(plugin.id))} />
        <RunBoundStat app={app} pluginId={plugin.id} />
      </dl>
      {runStatus == null ? null : <AppRunStatusBar status={runStatus} />}
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
