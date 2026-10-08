/**
 * @fileoverview App review plugin card components with run status display.
 * @module pages/Scrapers/AppConfigComponents
 */

import clsx from 'clsx'
import {
  Smartphone, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  appField, getAppIdentifier, getFrequencyLabel,
} from './scraper-helpers'
import { CardActions, CardStat } from './SourceCardParts'
import { ToneTile } from './SourceDialogHeader'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

export interface RunStatusInfo {
  status: string
  items_found: number
  errors: string[]
}

function getPlatformLabel(pluginId: string): string {
  if (pluginId === 'app_reviews_ios') return 'iOS'
  if (pluginId === 'app_reviews_android') return 'Android'
  return 'App'
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
      {status.errors.length > 0 ? <div className="mt-1 text-xs text-danger truncate">{status.errors[0]}</div> : null}
    </div>
  )
}

export function AppConfigCard({
  app, plugin, isAdmin, onEdit, onDelete, onRun, isRunning, runStatus,
}: Readonly<{
  app: AppConfig
  plugin: PluginManifest
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
  const frequencyLabel = getFrequencyLabel(frequencyMinutes)
  const name = app.app_name === '' ? t('appCard.unnamed') : app.app_name
  const identifier = getAppIdentifier(app, plugin.id)

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <ToneTile icon={Smartphone} tone="accent" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-text-strong truncate" title={name}>{name}</h2>
            <p className="text-sm text-muted truncate font-mono" title={identifier}>{identifier}</p>
          </div>
        </div>
        <CardActions
          isAdmin={isAdmin}
          isRunning={isRunning}
          runDisabled={isRunning}
          onRun={onRun}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
      <dl className="grid grid-cols-3 gap-3 sm:gap-4">
        <CardStat label={t('card.frequency')} value={frequencyLabel} />
        <CardStat label={t('appCard.platform')} value={getPlatformLabel(plugin.id)} />
        <CardStat label={t('appCard.maxReviews')} value={app.max_reviews_per_run === '' ? '500' : app.max_reviews_per_run} mono />
      </dl>
      {runStatus == null ? null : <AppRunStatusBar status={runStatus} />}
    </div>
  )
}
