/**
 * @fileoverview "Dimensions and tags" for a source of reviews (a feedback form,
 * a scraper): the dimension values and tags every review it produces carries.
 * The review's own values win per key at processing time.
 *
 * @module components/DimensionFields/DimensionDefaultsSection
 */
import { useTranslation } from 'react-i18next'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import DimensionValuesFields from './DimensionValuesFields'
import TagsField from './TagsField'
import type { ReactNode } from 'react'

interface DimensionDefaultsSectionProps {
  dimensionDefaults: Readonly<Record<string, string>> | undefined
  tags: readonly string[] | undefined
  onChange: (patch: { dimension_defaults?: Record<string, string>; tags?: string[] }) => void
  /** Context-specific note under the heading (e.g. the widget embed option). */
  hint?: ReactNode
}

export default function DimensionDefaultsSection({ dimensionDefaults, tags, onChange, hint }: Readonly<DimensionDefaultsSectionProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionFields' })
  const { data } = useDimensionsConfig()
  const dimensions = data?.dimensions ?? []
  return (
    <section className="space-y-3 rounded-lg border border-border p-3 sm:p-4" aria-label={t('defaultsTitle')}>
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('defaultsTitle')}</h3>
        <p className="text-xs text-muted mt-1">{hint ?? t('defaultsHint')}</p>
      </div>
      {dimensions.length === 0 ? <p className="text-xs text-muted">{t('noDimensions')}</p> : (
        <DimensionValuesFields
          dimensions={dimensions}
          value={dimensionDefaults ?? {}}
          onChange={(defaults) => onChange({ dimension_defaults: defaults })}
          emptyLabel={t('noDefault')}
        />
      )}
      <TagsField tags={tags ?? []} onChange={(next) => onChange({ tags: next })} />
    </section>
  )
}
