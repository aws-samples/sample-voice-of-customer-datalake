/**
 * @fileoverview Radar (docs/radar.md): other brands tracked by Radar sources,
 * kept apart from our own feedback. One aggregated view per brand (a brand
 * selector, not a wall of cards): sentiment trend, what their customers love
 * and hate, their releases with citations, and how we compare per category.
 * With two brands or more, "All brands" (`?brand=all`) shows them side by side (AllBrandsView).
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
import { PageTitle } from '../../components/PageTitle/PageTitle'
import AllBrandsView from './AllBrandsView'
import BrandSentiment from './BrandSentiment'
import CompareTable from './CompareTable'
import RadarEmptyState from './RadarEmptyState'
import { RadarLoadFailed, RadarLoading } from './RadarQueryState'
import { LastScan, ScanNow } from './RadarScan'
import ReleasesTimeline from './ReleasesTimeline'
import ReviewsModal from './ReviewsModal'
import { useIsAdmin } from '../../store/authStore'
import { useCategoriesConfig } from '../../hooks/useCategories'
import { useSourceProfiles } from '../../hooks/useDimensions'
import { DEFAULT_RADAR_WINDOW, RADAR_SETUP_PATH, RADAR_WINDOWS } from './radarFormat'
import { ALL_BRANDS, allBrandsQuery, brandPageQuery } from './radarQueries'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarBrandSummary } from '../../api/radarSchema'

function BrandView({ brand, days }: Readonly<{ brand: string; days: number }>) {
  const page = useQuery(brandPageQuery(brand, days))
  // The filter the reviews modal opened with; null = closed.
  const [reading, setReading] = useState<RadarReviewFilter | null>(null)
  if (page.isLoading) return <RadarLoading />
  const detail = page.data?.detail
  if (page.isError || !page.data || !detail) return <RadarLoadFailed query={page} />
  return (
    <div className="space-y-4 sm:space-y-6">
      <BrandSentiment detail={detail} onRead={setReading} />
      <ReleasesTimeline releases={page.data.releases} />
      <CompareTable compare={page.data.compare} onRead={setReading} />
      {reading === null ? null : (
        <ReviewsModal brand={detail.brand} days={days} initialFilter={reading} onClose={() => setReading(null)} />
      )}
    </div>
  )
}

/**
 * Start what the page will need while `/radar` (the brand list) is still on its way, instead of
 * after it: the brand page of a linked `?brand=` (Home's "Open Radar"), and the categories config
 * and source profiles every theme / category label reads (useDisplayLabels; shared cache entries).
 * An unknown linked brand is a 404 nobody shows: the page then reads the first brand. A linked
 * `?brand=all` starts the "All brands" read instead.
 */
function useEarlyReads(): void {
  const [params] = useSearchParams()
  const linked = params.get('brand') ?? ''
  const [days] = useChosenWindow()
  useQuery({ ...brandPageQuery(linked, days), enabled: linked !== '' && linked !== ALL_BRANDS })
  useQuery({ ...allBrandsQuery(days), enabled: linked === ALL_BRANDS })
  useCategoriesConfig()
  useSourceProfiles()
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
          {offersAll(brands) ? <option value={ALL_BRANDS}>{t('all.option')}</option> : null}
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

/** "All brands" is offered once there is more than one brand to put side by side. */
const offersAll = (brands: readonly RadarBrandSummary[]): boolean => brands.length >= 2

/** `setParams` that sets ONE param (replacing the history entry), keeping every other one (`?review=`). */
function setParam(setParams: SetURLSearchParams, name: string, value: string): void {
  setParams((prev) => new URLSearchParams([...[...prev].filter(([key]) => key !== name), [name, value]]), { replace: true })
}

/**
 * The chosen brand lives in `?brand=<key>` (Home's "Open Radar" links there): an unknown or absent
 * key shows the first brand; picking another replaces the param, keeping every other one (`?review=`).
 * `?brand=all` is "All brands" while it is offered; a brand whose key is `all` wins over it.
 */
function chosenBrand(brands: readonly RadarBrandSummary[], chosen: string): string {
  if (brands.some((b) => b.key === chosen)) return chosen
  if (chosen === ALL_BRANDS && offersAll(brands)) return ALL_BRANDS
  return brands[0]?.key ?? ''
}

function useChosenBrand(brands: readonly RadarBrandSummary[]): readonly [string, (key: string) => void] {
  const [params, setParams] = useSearchParams()
  const brand = chosenBrand(brands, params.get('brand') ?? '')
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
      {brand === ALL_BRANDS
        ? <AllBrandsView days={days} onBrand={choose} />
        : <BrandView key={brand} brand={brand} days={days} />}
    </>
  )
}

export default function Radar() {
  const { t } = useTranslation('radar')
  const isAdmin = useIsAdmin()
  useEarlyReads()
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
      {/* Admins start the release / news scan here too, not only in Administration (POST /radar/scan is admin-only). */}
      {isAdmin && overview.data && overview.data.brands.length > 0 ? (
        <section aria-label={t('settings.scanNow')} className="space-y-1">
          <ScanNow />
          <LastScan scan={overview.data.last_scan} />
        </section>
      ) : null}
      {overview.isLoading ? <RadarLoading /> : null}
      {overview.isError ? <RadarLoadFailed query={overview} /> : null}
      {overview.data ? <RadarBody brands={overview.data.brands} /> : null}
    </div>
  )
}
