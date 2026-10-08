/**
 * @fileoverview One source profile: label, PII policy, retention, whether it is
 * restricted, and the dimension values and tags every review from it gets.
 *
 * @module components/SourcesManager/SourceProfileEditor
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { RemoveRowButton } from '../DraftSaveBar/DraftParts'
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, PII_POLICIES } from '../../api/sourceProfilesApi'
import DimensionValuesFields from '../DimensionFields/DimensionValuesFields'
import TagsField from '../DimensionFields/TagsField'
import SwitchField from '../SwitchField/SwitchField'
import type { Dimension } from '../../api/dimensionsSchema'
import type { SourceProfile } from '../../api/sourceProfilesApi'
import { PII_COPY, isPiiPolicy } from './piiPolicy'

interface SourceProfileEditorProps {
  profile: SourceProfile
  keepForever: boolean
  /** The days input as typed (validated by the manager). */
  retentionText: string
  dimensions: readonly Dimension[]
  onChange: (profile: SourceProfile) => void
  onRetentionChange: (change: { keepForever?: boolean; retentionText?: string }) => void
  onTagsValidityChange: (valid: boolean) => void
  onRemove: () => void
}

function RetentionField({ keepForever, retentionText, onChange }: Readonly<{
  keepForever: boolean; retentionText: string; onChange: SourceProfileEditorProps['onRetentionChange']
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const id = useId()
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={keepForever} onChange={(e) => onChange({ keepForever: e.target.checked })} />
        {t('keepForever')}
      </label>
      {!keepForever && (
        <div>
          <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{t('retentionLabel')}</label>
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            value={retentionText}
            onChange={(e) => onChange({ retentionText: e.target.value })}
            className="input font-mono w-32"
          />
          <p className="text-xs text-muted mt-1">{t('retentionHint', { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS })}</p>
        </div>
      )}
    </div>
  )
}

export default function SourceProfileEditor({
  profile, keepForever, retentionText, dimensions, onChange, onRetentionChange, onTagsValidityChange, onRemove,
}: Readonly<SourceProfileEditorProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const { t: tAll } = useTranslation()
  const labelId = useId()
  const piiId = useId()
  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-label={profile.label}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold tracking-tight text-text-strong flex items-center gap-2">
          {profile.restricted && <Lock size={14} className="text-warn" aria-hidden="true" />}
          {profile.label} <span className="font-mono text-xs text-muted">{profile.id}</span>
        </h4>
        <RemoveRowButton label={t('removeProfile', { name: profile.label })} onRemove={onRemove} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={labelId} className="block text-xs font-medium text-text mb-1">{t('labelLabel')}</label>
          <input id={labelId} type="text" value={profile.label} onChange={(e) => onChange({ ...profile, label: e.target.value })} className="input" />
        </div>
        <div>
          <label htmlFor={piiId} className="block text-xs font-medium text-text mb-1">{t('piiLabel')}</label>
          <select
            id={piiId}
            value={profile.pii}
            onChange={(e) => { if (isPiiPolicy(e.target.value)) onChange({ ...profile, pii: e.target.value }) }}
            className="select"
          >
            {PII_POLICIES.map((p) => <option key={p} value={p}>{tAll(PII_COPY[p].labelKey)}</option>)}
          </select>
          <p className="text-xs text-muted mt-1">{tAll(PII_COPY[profile.pii].hintKey)}</p>
        </div>
      </div>
      <RetentionField keepForever={keepForever} retentionText={retentionText} onChange={onRetentionChange} />
      <SwitchField checked={profile.restricted} onChange={(restricted) => onChange({ ...profile, restricted })} label={t('restrictedLabel')} hint={t('restrictedHint')} />
      {dimensions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-text mb-2">{t('defaultsTitle')}</p>
          <DimensionValuesFields
            dimensions={dimensions}
            value={profile.dimension_defaults}
            onChange={(defaults) => onChange({ ...profile, dimension_defaults: defaults })}
            emptyLabel={t('noDefault')}
          />
        </div>
      )}
      <TagsField tags={profile.tags} onChange={(tags) => onChange({ ...profile, tags })} onValidityChange={onTagsValidityChange} />
    </section>
  )
}
