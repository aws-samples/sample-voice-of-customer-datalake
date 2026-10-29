/**
 * @fileoverview The Radar release scan's controls, shared by the Radar page header (admins) and
 * Administration → Sources → Radar: the last scan in words, and "Scan now" (POST /radar/scan, admin-only
 * server-side), which web-searches every tracked brand's own domains and the web for its releases and news,
 * ignoring the cadence (docs/radar.md).
 * @module pages/Radar/RadarScan
 */
import { useMutation } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { radarApi } from '../../api/radarApi'
import { formatDateTime } from '../../utils/dateUtils'
import type { RadarScan } from '../../api/radarSchema'

/** "2 brands, 12 searches, 3 new releases, 1 merged", each count pluralized on its own. */
function scanCounts(scan: RadarScan, t: TFunction<'radar'>): string {
  return t('settings.lastScanCounts', {
    brands: t('settings.scanBrands', { count: scan.brands }),
    queries: t('settings.scanQueries', { count: scan.queries }),
    added: t('settings.scanAdded', { count: scan.added }),
    merged: t('settings.scanMerged', { count: scan.merged }),
  })
}

export function LastScan({ scan }: Readonly<{ scan: RadarScan | null }>) {
  const { t, i18n } = useTranslation('radar')
  if (scan === null) return <p className="text-xs text-muted">{t('settings.neverScanned')}</p>
  const when = formatDateTime(scan.finished_at ?? scan.started_at, i18n.language)
  return (
    <p className="text-xs text-muted">
      {t('settings.lastScan', { status: t(`settings.status.${scan.status}`), when })}
      {scan.status === 'completed' ? ` (${scanCounts(scan, t)})` : ''}
    </p>
  )
}

/** "Scan now" for every tracked brand, with what it does (described by the hint) and whether it started. */
export function ScanNow() {
  const { t } = useTranslation('radar')
  const hintId = useId()
  const scan = useMutation({ mutationFn: () => radarApi.startScan() })
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-secondary btn-sm" disabled={scan.isPending} aria-describedby={hintId}
          onClick={() => scan.mutate()}>
          <RefreshCw size={14} aria-hidden="true" className={scan.isPending ? 'animate-spin' : undefined} />
          {t('settings.scanNow')}
        </button>
        {scan.isSuccess ? <p role="status" className="text-xs text-ok">{t('settings.scanStarted')}</p> : null}
        {scan.isError ? <p role="alert" className="text-xs text-danger">{t('settings.scanFailed')}</p> : null}
      </div>
      <p id={hintId} className="text-xs text-muted">{t('settings.scanNowHint')}</p>
    </div>
  )
}
