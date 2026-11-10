/**
 * @fileoverview "Radar source: reviews of another brand" on a source the Scrapers page sets up
 * (a custom scraper, a Web Reviews page, an app connector, a CSV/JSON upload). Ticked, a select
 * of the Radar brands (GET /radar/brands) picks the brand; the source then saves
 * `radar_brand: <brand key>` and its reviews go to Radar only (docs/radar.md). With no brand
 * yet, an inline link leads to Administration → Sources → Radar. Unticked = `''` (an ordinary
 * source). A stored key that is no longer in the list stays selected, marked as such, so a
 * save never drops it silently.
 * @module pages/Scrapers/RadarSourcePicker
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RADAR_SETUP_PATH } from '../Radar/radarFormat'
import { useRadarBrands } from './useRadarBrands'
import type { RadarBrandEntry } from '../../api/radarSchema'

function NoBrand() {
  const { t } = useTranslation('scrapers')
  return (
    <p className="text-xs text-muted">
      {t('radarSource.noBrand')}{' '}
      <Link to={RADAR_SETUP_PATH} className="link">{t('radarSource.addBrand')}</Link>
    </p>
  )
}

function BrandSelect({ brands, value, disabled, onChange }: Readonly<{
  brands: readonly RadarBrandEntry[]; value: string; disabled: boolean; onChange: (key: string) => void
}>) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  const unknown = value !== '' && !brands.some((brand) => brand.key === value)
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{t('radarSource.brandLabel')}</label>
      <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('radarSource.choose')}</option>
        {brands.map((brand) => <option key={brand.key} value={brand.key}>{brand.label}</option>)}
        {unknown ? <option value={value}>{t('radarSource.unknownBrand', { key: value })}</option> : null}
      </select>
      {value === '' ? <p className="text-xs text-muted mt-1">{t('radarSource.needsBrand')}</p> : null}
    </div>
  )
}

function BrandChoice({ value, disabled, onChange }: Readonly<{ value: string; disabled: boolean; onChange: (key: string) => void }>) {
  const { t } = useTranslation('scrapers')
  const brands = useRadarBrands()
  if (brands.isError) return <p role="alert" className="text-xs text-danger">{t('radarSource.loadFailed')}</p>
  if (!brands.data) return <p className="text-xs text-muted">{t('radarSource.loading')}</p>
  if (brands.data.length === 0 && value === '') return <NoBrand />
  return <BrandSelect brands={brands.data} value={value} disabled={disabled} onChange={onChange} />
}

export default function RadarSourcePicker({ value, onChange, disabled = false }: Readonly<{
  /** The chosen brand key; `''` for an ordinary source. */
  value: string
  onChange: (brandKey: string) => void
  /** Read-only (a non-admin looking at a source); a surrounding disabled fieldset does the same. */
  disabled?: boolean
}>) {
  const { t } = useTranslation('scrapers')
  const brands = useRadarBrands()
  // Ticked with no brand chosen yet is a state of its own: the source stays ordinary until one is.
  const [checked, setChecked] = useState(value !== '')
  const toggle = (next: boolean) => {
    setChecked(next)
    // With one brand there is nothing to choose; otherwise the select asks.
    const only = brands.data?.length === 1 ? (brands.data.at(0)?.key ?? '') : ''
    onChange(next ? only : '')
  }
  return (
    <div className="border border-border rounded-lg p-3 sm:p-4 space-y-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" className="rounded-sm accent-accent" checked={checked} disabled={disabled}
          onChange={(e) => toggle(e.target.checked)} />
        <span className="font-medium text-sm">{t('radarSource.label')}</span>
      </label>
      <p className="text-xs text-muted">{t('radarSource.hint')}</p>
      {checked ? <BrandChoice value={value} disabled={disabled} onChange={onChange} /> : null}
    </div>
  )
}
