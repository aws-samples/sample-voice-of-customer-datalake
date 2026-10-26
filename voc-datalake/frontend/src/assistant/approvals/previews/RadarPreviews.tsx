/**
 * @fileoverview Approval previews of the Radar write tools (docs/radar.md).
 * Deterministic: rows come from the validated args and GET /radar/brands read
 * fresh at render — no model-written prose.
 *
 * - save_radar_brands: one row per brand (stored list ∪ proposed list), its
 *   domains before → after, unchanged brands collapsed; brands that come from
 *   source profiles are listed as kept. The fingerprint of the stored list goes
 *   on the shown record, so the executor refuses if it changed before approval.
 * - run_radar_scan: which brand(s) a scan covers, and what it costs.
 *
 * @module assistant/approvals/previews/RadarPreviews
 */
import { useContext, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { brandKeyOf, radarListFingerprint } from '../radarSchemas'
import { ShownContext, recordRadarBrandsBase } from '../shown'
import { CardNote, FieldDiff, FieldTable, NothingSavedNote } from './FieldDiff'
import { Lines, Muted } from './ScraperValues'
import { useRadarBrandLabels, useRadarBrandsPreview } from './useRadarBrands'
import type { RunRadarScanArgs, SaveRadarBrandsArgs } from '../radarSchemas'
import type { RadarBrandEntry } from '../../../api/radarSchema'
import type { FieldRow } from './FieldDiff'

type Translate = (key: string, options?: Record<string, unknown>) => string

const K = 'preview.radar'

interface BrandSide { label: string; domains: readonly string[] }

function domainsRow(key: string, side: BrandSide | undefined, fallbackLabel: string, missing: string, t: Translate): FieldRow {
  const value = side === undefined
    ? <Muted text={missing} />
    : <Lines items={side.domains} empty={t(`${K}.noDomains`)} />
  return { key, label: side?.label ?? fallbackLabel, value, compare: side === undefined ? '' : JSON.stringify([side.label, side.domains]) }
}

/** Aligned before / after rows over every brand key of either list (stored order first, then the new ones). */
function brandRows(stored: readonly RadarBrandEntry[], args: SaveRadarBrandsArgs, t: Translate) {
  const before = new Map(stored.filter((entry) => entry.origin === 'list').map((entry): [string, BrandSide] => [entry.key, entry]))
  const after = new Map(args.brands.map((brand): [string, BrandSide] => [brandKeyOf(brand.label), { label: brand.label, domains: brand.domains ?? [] }]))
  const keys = [...new Set([...before.keys(), ...after.keys()])]
  const labelOf = (key: string) => after.get(key)?.label ?? before.get(key)?.label ?? key
  return {
    beforeRows: keys.map((key) => domainsRow(key, before.get(key), labelOf(key), t(`${K}.notTracked`), t)),
    afterRows: keys.map((key) => domainsRow(key, after.get(key), labelOf(key), t(`${K}.removed`), t)),
  }
}

export function RadarBrandsPreview({ args }: Readonly<{ args: SaveRadarBrandsArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const { data, isLoading, isError } = useRadarBrandsPreview()
  useEffect(() => {
    if (shown !== null) recordRadarBrandsBase(shown, data === undefined ? undefined : radarListFingerprint(data))
  }, [shown, data])
  if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
  if (isError || data === undefined) return <p role="alert" className="text-[12px] text-danger">{t(`${K}.unavailable`)}</p>
  const profileBrands = data.filter((entry) => entry.origin === 'profile' && !args.brands.some((brand) => brandKeyOf(brand.label) === entry.key))
  return (
    <div className="space-y-2">
      <FieldDiff {...brandRows(data, args, t)} />
      {profileBrands.length > 0 && (
        <CardNote text={t(`${K}.profileKept`, { brands: profileBrands.map((entry) => entry.label).join(', ') })} />
      )}
      <CardNote text={t(`${K}.removalKeepsData`)} />
      <NothingSavedNote />
    </div>
  )
}

export function RadarScanPreview({ args }: Readonly<{ args: RunRadarScanArgs }>) {
  const { t } = useTranslation('assistantTools')
  const labels = useRadarBrandLabels()
  const brand = args.brand === undefined ? t(`${K}.everyBrand`) : labels.get(args.brand) ?? args.brand
  return (
    <div className="space-y-2">
      <FieldTable rows={[{ key: 'brand', label: t(`${K}.brand`), value: brand, compare: args.brand ?? '' }]} label={t(`${K}.scanFields`)} />
      <CardNote text={t(`${K}.scanCost`)} />
    </div>
  )
}
