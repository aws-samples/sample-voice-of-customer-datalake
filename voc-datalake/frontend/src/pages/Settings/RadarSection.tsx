/**
 * @fileoverview Administration → Sources → Radar (admin): the brands tracked and how Radar
 * works (RadarSetupGuide), the release-scan cadence and its cost guards, the last scan, and
 * "Scan now" (docs/radar.md).
 * @module pages/Settings/RadarSection
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Radar, RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import { CADENCES, MAX_BRANDS_LIMIT, QUERY_CAP_LIMIT } from '../../api/radarSchema'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { formatDateTime } from '../../utils/dateUtils'
import RadarSetupGuide from './RadarSetupGuide'
import type { RadarCadence, RadarScan, RadarSettings } from '../../api/radarSchema'

function isCadence(value: string): value is RadarCadence {
  return CADENCES.some((cadence) => cadence === value)
}

function NumberField({ label, hint, value, max, onChange }: Readonly<{
  label: string; hint?: string; value: number; max: number; onChange: (value: number) => void
}>) {
  const id = useId()
  // The digits as typed; only a whole number in range reaches the draft.
  const [text, setText] = useState(String(value))
  const accept = (typed: string) => {
    setText(typed)
    const parsed = Number(typed)
    if (typed.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= max) onChange(parsed)
  }
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{label}</label>
      <input id={id} type="number" inputMode="numeric" min={1} max={max} value={text} className="input font-mono w-32"
        onChange={(e) => accept(e.target.value)} />
      {hint === undefined ? null : <p className="text-xs text-muted mt-1">{hint}</p>}
    </div>
  )
}

function SettingsForm({ initial }: Readonly<{ initial: RadarSettings }>) {
  const { t } = useTranslation('radar')
  const queryClient = useQueryClient()
  const cadenceId = useId()
  const [draft, setDraft] = useState<RadarSettings>(initial)
  const save = useMutation({
    mutationFn: (settings: RadarSettings) => radarApi.saveSettings(settings),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: radarKeys.overview() }) },
  })
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(draft) }}>
      <div>
        <label htmlFor={cadenceId} className="block text-xs font-medium text-text mb-1">{t('settings.cadence')}</label>
        <select id={cadenceId} className="select w-auto" value={draft.cadence}
          onChange={(e) => { if (isCadence(e.target.value)) setDraft({ ...draft, cadence: e.target.value }) }}>
          {CADENCES.map((cadence) => <option key={cadence} value={cadence}>{t(`settings.cadences.${cadence}`)}</option>)}
        </select>
      </div>
      <NumberField label={t('settings.maxBrands')} value={draft.max_brands} max={MAX_BRANDS_LIMIT}
        onChange={(value) => setDraft({ ...draft, max_brands: value })} />
      <NumberField label={t('settings.queryCap')} hint={t('settings.queryCapHint')} value={draft.query_cap}
        max={QUERY_CAP_LIMIT} onChange={(value) => setDraft({ ...draft, query_cap: value })} />
      <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>{t('settings.save')}</button>
        {save.isSuccess ? <p role="status" className="text-xs text-ok">{t('settings.saved')}</p> : null}
        {save.isError ? <p role="alert" className="text-xs text-danger">{t('settings.saveFailed')}</p> : null}
      </StickyActionBar>
    </form>
  )
}

/** "2 brands, 12 searches, 3 new releases, 1 merged", each count pluralized on its own. */
function scanCounts(scan: RadarScan, t: TFunction<'radar'>): string {
  return t('settings.lastScanCounts', {
    brands: t('settings.scanBrands', { count: scan.brands }),
    queries: t('settings.scanQueries', { count: scan.queries }),
    added: t('settings.scanAdded', { count: scan.added }),
    merged: t('settings.scanMerged', { count: scan.merged }),
  })
}

function LastScan({ scan }: Readonly<{ scan: RadarScan | null }>) {
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

function ScanNow() {
  const { t } = useTranslation('radar')
  const scan = useMutation({ mutationFn: () => radarApi.startScan() })
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn btn-secondary btn-sm" disabled={scan.isPending} onClick={() => scan.mutate()}>
        <RefreshCw size={14} aria-hidden="true" className={scan.isPending ? 'animate-spin' : undefined} />
        {t('settings.scanNow')}
      </button>
      {scan.isSuccess ? <p role="status" className="text-xs text-ok">{t('settings.scanStarted')}</p> : null}
      {scan.isError ? <p role="alert" className="text-xs text-danger">{t('settings.scanFailed')}</p> : null}
    </div>
  )
}

/** GET /radar: the same cache entry the Radar page reads. */
function useRadarOverview() {
  return useQuery({ queryKey: radarKeys.overview(), queryFn: () => radarApi.getOverview() })
}

/** Loading, a failed read with a retry (never an empty "no brand" claim), or the setup and settings. */
function RadarSectionBody({ overview }: Readonly<{ overview: ReturnType<typeof useRadarOverview> }>) {
  const { t } = useTranslation('radar')
  if (overview.isError) {
    return <LoadFailed message={t('loadFailed')} onRetry={() => { void overview.refetch() }} retrying={overview.isFetching} />
  }
  if (!overview.data) return <p className="text-sm text-muted">{t('loading')}</p>
  return (
    <>
      <RadarSetupGuide brands={overview.data.brands} />
      <SettingsForm key={JSON.stringify(overview.data.settings)} initial={overview.data.settings} />
      <LastScan scan={overview.data.last_scan} />
      <ScanNow />
    </>
  )
}

export default function RadarSection() {
  const { t } = useTranslation('radar')
  const overview = useRadarOverview()
  return (
    <div className="card space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Radar className="text-accent" size={16} aria-hidden="true" />
          <h2 className="text-lg font-semibold tracking-tight text-text-strong">{t('settings.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('settings.description')}</p>
      </div>
      <RadarSectionBody overview={overview} />
    </div>
  )
}
