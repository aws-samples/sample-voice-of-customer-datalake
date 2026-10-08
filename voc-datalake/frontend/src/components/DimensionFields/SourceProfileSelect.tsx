/**
 * @fileoverview Pick the source profile an import belongs to (`source_id`):
 * `manual_import` plus every configured profile; restricted ones are marked.
 *
 * @module components/DimensionFields/SourceProfileSelect
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { MANUAL_IMPORT_SOURCE } from '../../api/sourceProfilesApi'
import { useSourceProfiles } from '../../hooks/useDimensions'

interface SourceProfileSelectProps {
  value: string
  onChange: (sourceId: string) => void
  disabled?: boolean
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
          <option key={p.id} value={p.id}>{p.restricted ? t('restrictedOption', { name: p.label }) : p.label}</option>
        ))}
      </select>
      <p className="text-xs text-muted mt-1">{chosen?.restricted === true ? t('sourceRestrictedHint') : t('sourceHint')}</p>
    </div>
  )
}
