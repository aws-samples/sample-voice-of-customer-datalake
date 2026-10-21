/**
 * @fileoverview Badges for a feedback item's registry enrichment fields
 * (api/enrichmentFields.ts — e.g. usefulness). Renders nothing for fields the
 * item has no value for, so unscored items stay uncluttered.
 *
 * @module components/EnrichmentBadges
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ENRICHMENT_FIELDS } from '../../api/enrichmentFields'
import { enrichmentLabel, enrichmentValueLabel } from '../../utils/enrichmentLabels'

/** Colour by position in the field's declared order (most → least favourable). */
const TONES = ['bg-green-100 text-green-800', 'bg-amber-100 text-amber-800', 'bg-gray-100 text-gray-600'] as const

function toneFor(values: readonly string[], value: string): string {
  const index = Math.min(Math.max(values.indexOf(value), 0), TONES.length - 1)
  return TONES[index]
}

export function EnrichmentBadges({
  enrichment,
  className,
}: Readonly<{ enrichment: Readonly<Record<string, string>> | undefined; className?: string }>) {
  const { t } = useTranslation('common')
  const present = ENRICHMENT_FIELDS.filter((field) => enrichment?.[field.name] !== undefined)
  if (present.length === 0) return null
  return (
    <>
      {present.map((field) => {
        const value = enrichment?.[field.name] ?? ''
        return (
          <span key={field.name} className={clsx('badge text-xs', toneFor(field.values, value), className)}>
            {enrichmentLabel(t, field.name)}: {enrichmentValueLabel(t, field.name, value)}
          </span>
        )
      })}
    </>
  )
}
