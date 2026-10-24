/**
 * @fileoverview Pick the source profile an import belongs to (`source_id`):
 * `manual_import` plus every configured profile; restricted ones are marked.
 *
 * @module components/DimensionFields/SourceProfileSelect
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { MANUAL_IMPORT_SOURCE } from '../../api/sourceProfilesApi'
import type { SourceProfile } from '../../api/sourceProfilesApi'
import { useSourceProfiles } from '../../hooks/useDimensions'
import { sourceLabel } from '../../utils/displayLabels'

interface SourceProfileSelectProps {
  value: string
  onChange: (sourceId: string) => void
  disabled?: boolean
}

/** Where the rows go: a Radar source's to the Radar page, a restricted one's to its readers only. */
function sourceHint(chosen: SourceProfile | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (chosen?.radar_brand !== undefined) return t('sourceRadarHint', { brand: chosen.radar_brand })
  return chosen?.restricted === true ? t('sourceRestrictedHint') : t('sourceHint')
}

export default function SourceProfileSelect({ value, onChange, disabled = false }: Readonly<SourceProfileSelectProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionFields' })
  const id = useId()
  const { data: profiles = [] } = useSourceProfiles()
  const others = profiles.filter((p) => p.id !== MANUAL_IMPORT_SOURCE)
  const chosen = profiles.find((p) => p.id === value)
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{t('sourceLabel')}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="select">
        <option value={MANUAL_IMPORT_SOURCE}>{t('manualImport')}</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>{p.restricted ? t('restrictedOption', { name: sourceLabel(p.id, profiles) }) : sourceLabel(p.id, profiles)}</option>
        ))}
      </select>
      <p className="text-xs text-muted mt-1">{sourceHint(chosen, t)}</p>
    </div>
  )
}
