/**
 * @fileoverview Radar (docs/radar.md): other brands tracked by Radar sources,
 * kept apart from our own feedback. One aggregated view per brand (a brand
 * selector, not a wall of cards): sentiment trend, what their customers love
 * and hate, their releases with citations, and how we compare per category.
 *
 * @module pages/Radar
 */
import { useQuery } from '@tanstack/react-query'
import { Info, Settings } from 'lucide-react'
import { useId, useState } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { radarApi, radarKeys } from '../../api/radarApi'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BrandSentiment from './BrandSentiment'
import CompareTable from './CompareTable'
import RadarEmptyState from './RadarEmptyState'
import ReleasesTimeline from './ReleasesTimeline'
import ReviewsModal from './ReviewsModal'
import { useIsAdmin } from '../../store/authStore'
import { DEFAULT_RADAR_WINDOW, RADAR_SETUP_PATH, RADAR_WINDOWS } from './radarFormat'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarBrandSummary } from '../../api/radarSchema'

function BrandView({ brand, days }: Readonly<{ brand: string; days: number }>) {
  const { t } = useTranslation('radar')
  const detail = useQuery({ queryKey: radarKeys.detail(brand, days), queryFn: () => radarApi.getDetail(brand, days) })
  const releases = useQuery({ queryKey: radarKeys.releases(brand), queryFn: () => radarApi.getReleases(brand) })
  const compare = useQuery({ queryKey: radarKeys.compare(brand, days), queryFn: () => radarApi.getCompare(brand, days) })
  // The filter the reviews modal opened with; null = closed.
  const [reading, setReading] = useState<RadarReviewFilter | null>(null)
  if (detail.isLoading) return <p className="text-sm text-muted">{t('loading')}</p>
  if (detail.isError || !detail.data) {
    return <LoadFailed message={t('loadFailed')} onRetry={() => { void detail.refetch() }} retrying={detail.isFetching} />
  }
  return (
    <div className="space-y-4 sm:space-y-6">
      <BrandSentiment detail={detail.data} onRead={setReading} />
      <ReleasesTimeline releases={releases.data ?? []} />
      {compare.data ? <CompareTable compare={compare.data} onRead={setReading} /> : null}
      {reading === null ? null : (
        <ReviewsModal brand={detail.data.brand} days={days} initialFilter={reading} onClose={() => setReading(null)} />
      )}
    </div>
  )
}

/** The header's own label for a preset of the same length; a year (no header preset) reads "Last 365 days". */
const WINDOW_LABEL_KEY: Readonly<Partial<Record<number, string>>> = {
  7: 'common:timeRange.7dFull', 30: 'common:timeRange.30dFull', 90: 'common:timeRange.90dFull',
}

function windowLabel(days: number, t: TFunction): string {
  const key = WINDOW_LABEL_KEY[days]
  return key === undefined ? t('radar:windowDays', { count: days }) : t(key)
}

function Pickers({ brands, brand, days, onBrand, onDays }: Readonly<{
  brands: readonly RadarBrandSummary[]; brand: string; days: number
  onBrand: (key: string) => void; onDays: (days: number) => void
}>) {
  const { t } = useTranslation('radar')
  const brandId = useId()
  const windowId = useId()
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={brandId} className="block text-xs font-medium text-text mb-1">{t('brandLabel')}</label>
        <select id={brandId} className="select w-auto" value={brand} onChange={(e) => onBrand(e.target.value)}>
          {brands.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={windowId} className="block text-xs font-medium text-text mb-1">{t('windowLabel')}</label>
        <select id={windowId} className="select w-auto" value={days} onChange={(e) => onDays(Number(e.target.value))}>
          {RADAR_WINDOWS.map((value) => <option key={value} value={value}>{windowLabel(value, t)}</option>)}
        </select>
      </div>
    </div>
  )
}

/** `setParams` that sets ONE param (replacing the history entry), keeping every other one (`?review=`). */
function setParam(setParams: SetURLSearchParams, name: string, value: string): void {
  setParams((prev) => new URLSearchParams([...[...prev].filter(([key]) => key !== name), [name, value]]), { replace: true })
}

/**
 * The chosen brand lives in `?brand=<key>` (Home's "Open Radar" links there): an unknown or absent
 * key shows the first brand; picking another replaces the param, keeping every other one (`?review=`).
 */
function useChosenBrand(brands: readonly RadarBrandSummary[]): readonly [string, (key: string) => void] {
  const [params, setParams] = useSearchParams()
  const chosen = params.get('brand') ?? ''
  const brand = brands.some((b) => b.key === chosen) ? chosen : brands[0]?.key ?? ''
  return [brand, (key: string) => { setParam(setParams, 'brand', key) }]
}

/**
 * The window lives in `?days=` beside the brand, so a shared or reloaded link shows the same
 * window. Only the offered windows are read; anything else (or none) is the 90-day default:
 * another brand's reviews are sparse, and a week usually shows nothing.
 */
function useChosenWindow(): readonly [number, (days: number) => void] {
  const [params, setParams] = useSearchParams()
  const asked = Number(params.get('days'))
  const days = RADAR_WINDOWS.find((value) => value === asked) ?? DEFAULT_RADAR_WINDOW
  return [days, (next: number) => { setParam(setParams, 'days', String(next)) }]
}

function RadarBody({ brands }: Readonly<{ brands: readonly RadarBrandSummary[] }>) {
  const { t } = useTranslation('radar')
  const [brand, choose] = useChosenBrand(brands)
  // The header's window choices and names ("7 Days", "30 Days", "90 Days", plus a year).
  const [days, setDays] = useChosenWindow()
  if (brand === '') return <RadarEmptyState />
  return (
    <>
      <Pickers brands={brands} brand={brand} days={days} onBrand={choose} onDays={setDays} />
      <p className="text-xs text-muted flex items-center gap-2"><Info size={14} aria-hidden="true" />{t('notice')}</p>
      <BrandView key={brand} brand={brand} days={days} />
    </>
  )
}

export default function Radar() {
  const { t } = useTranslation('radar')
  const isAdmin = useIsAdmin()
  const overview = useQuery({ queryKey: radarKeys.overview(), queryFn: () => radarApi.getOverview() })
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title={t('title')} subtitle={t('subtitle')} />
        {isAdmin ? (
          <Link to={RADAR_SETUP_PATH} className="btn btn-ghost btn-sm">
            <Settings size={14} aria-hidden="true" />
            {t('setup.configure')}
          </Link>
        ) : null}
      </div>
      {overview.isLoading ? <p className="text-sm text-muted">{t('loading')}</p> : null}
      {overview.isError ? (
        <LoadFailed message={t('loadFailed')} onRetry={() => { void overview.refetch() }} retrying={overview.isFetching} />
      ) : null}
      {overview.data ? <RadarBody brands={overview.data.brands} /> : null}
    </div>
  )
}
