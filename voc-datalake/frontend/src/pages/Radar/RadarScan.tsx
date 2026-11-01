/**
 * @fileoverview The Radar release scan's controls, shared by the Radar page header (admins) and
 * Administration → Sources → Radar: the last scan in words, and "Scan now" (POST /radar/scan, admin-only
 * server-side), which web-searches every tracked brand's own domains and the web for its releases and news,
 * ignoring the cadence (docs/radar.md).
 * @module pages/Radar/RadarScan
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import { formatDate, formatDateTime } from '../../utils/dateUtils'
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

type ScanMutation = UseMutationResult<unknown, Error, void>

/** POST /radar/scan for every tracked brand (admin-only server-side); the overview (its last scan) is re-read after. */
function useScanMutation(): ScanMutation {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => radarApi.startScan(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: radarKeys.overview() }),
  })
}

/** "Scan now" for every tracked brand, with what it does (described by the hint) and whether it started. */
export function ScanNow() {
  const { t } = useTranslation('radar')
  const hintId = useId()
  const scan = useScanMutation()
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <ScanButton scan={scan} hintId={hintId} />
        <ScanOutcome scan={scan} />
      </div>
      <p id={hintId} className="text-xs text-muted">{t('settings.scanNowHint')}</p>
    </div>
  )
}

function ScanButton({ scan, hintId, title }: Readonly<{ scan: ScanMutation; hintId: string; title?: string }>) {
  const { t } = useTranslation('radar')
  return (
    <button type="button" className="btn btn-secondary btn-sm" disabled={scan.isPending} aria-describedby={hintId}
      title={title} onClick={() => scan.mutate()}>
      <RefreshCw size={14} aria-hidden="true" className={scan.isPending ? 'animate-spin' : undefined} />
      {t('settings.scanNow')}
    </button>
  )
}

function ScanOutcome({ scan }: Readonly<{ scan: ScanMutation }>) {
  const { t } = useTranslation('radar')
  if (scan.isSuccess) return <p role="status" className="text-xs text-ok">{t('settings.scanStarted')}</p>
  if (scan.isError) return <p role="alert" className="text-xs text-danger">{t('settings.scanFailed')}</p>
  return null
}

/** "Last scan Oct 30" (or "No scan yet"), with the full status and counts in its tooltip. */
function scanWhen(scan: RadarScan | null, t: TFunction<'radar'>, language: string): { text: string; detail: string } {
  if (scan === null) return { text: t('scanLine.never'), detail: t('settings.neverScanned') }
  const finished = scan.finished_at ?? scan.started_at
  const full = t('settings.lastScan', { status: t(`settings.status.${scan.status}`), when: formatDateTime(finished, language) })
  return {
    text: t('scanLine.last', { when: formatDate(finished, language, '', 'short') }),
    detail: scan.status === 'completed' ? `${full} (${scanCounts(scan, t)})` : full,
  }
}

/**
 * The Radar page header's one admin line: "Last scan Oct 30 · Scan now". What the scan does is the
 * button's tooltip and accessible description; the full last-scan status is the date's tooltip.
 */
export function ScanStatusLine({ scan: last }: Readonly<{ scan: RadarScan | null }>) {
  const { t, i18n } = useTranslation('radar')
  const hintId = useId()
  const scan = useScanMutation()
  const when = scanWhen(last, t, i18n.language)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text min-w-0">
      <span title={when.detail} data-testid="radar-last-scan">{when.text}</span>
      <span aria-hidden="true" className="text-muted">·</span>
      <ScanButton scan={scan} hintId={hintId} title={t('settings.scanNowHint')} />
      <span id={hintId} className="sr-only">{t('settings.scanNowHint')}</span>
      <ScanOutcome scan={scan} />
    </div>
  )
}
