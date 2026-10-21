/**
 * @fileoverview Display labels for filter values and registry enrichment fields.
 *
 * Enrichment labels resolve from `common:enrichment.<field>.label` and
 * `common:enrichment.<field>.values.<value>`, falling back to the shared
 * `common:enrichment.values.<value>` and finally the humanized raw value, so a
 * field added to the registry (api/enrichmentFields.ts) renders readably before
 * anyone translates it.
 *
 * @module utils/enrichmentLabels
 */
import type { TFunction } from 'i18next'

/** `product_quality` → `product quality`. */
export const humanize = (value: string): string => value.replace(/_/g, ' ')

export function enrichmentLabel(t: TFunction, field: string): string {
  return t(`common:enrichment.${field}.label`, { defaultValue: humanize(field) })
}

export function enrichmentValueLabel(t: TFunction, field: string, value: string): string {
  return t(`common:enrichment.${field}.values.${value}`, {
    defaultValue: t(`common:enrichment.values.${value}`, { defaultValue: humanize(value) }),
  })
}
