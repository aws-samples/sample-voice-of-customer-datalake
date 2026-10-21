/**
 * Registry of LLM-derived enrichment fields that are filterable facets.
 *
 * Mirrors `lambda/shared/enrichment_fields.py` (pinned by
 * `lambda/shared/test/test_enrichment_fields.py`, which parses this file — keep
 * each entry's `name` and `values` on the shapes below). Adding a field is one
 * entry here, one in the Python registry, and its labels under
 * `common:enrichment.<name>` in every locale.
 */
import { z } from 'zod'

/** Filter value meaning "no value stored" — rows enriched before the field existed. */
export const UNSCORED = 'unscored'

export interface EnrichmentFieldDef {
  readonly name: string
  /** Allowed values, most to least favourable (the display order). */
  readonly values: readonly string[]
}

export const ENRICHMENT_FIELDS: readonly EnrichmentFieldDef[] = [
  { name: 'usefulness', values: ['high', 'medium', 'low'] },
]

/** Filter options for a field: its values plus the unscored bucket. */
export function enrichmentFilterOptions(field: EnrichmentFieldDef): string[] {
  return [...field.values, UNSCORED]
}

/** Map of field name → validated value, as carried on a normalized FeedbackItem. */
export type EnrichmentValues = Readonly<Record<string, string>>

const rawRecordSchema = z.record(z.string(), z.unknown())

/**
 * Pick the registry fields off a raw API record, keeping only declared values.
 * Anything missing or out of enum is omitted, so the UI shows it as unscored.
 */
export function pickEnrichmentValues(raw: unknown): EnrichmentValues {
  const parsed = rawRecordSchema.safeParse(raw)
  if (!parsed.success) return {}
  const out: Record<string, string> = {}
  for (const field of ENRICHMENT_FIELDS) {
    const value = parsed.data[field.name]
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (field.values.includes(normalized)) out[field.name] = normalized
  }
  return out
}
