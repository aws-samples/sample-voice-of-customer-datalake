/**
 * @fileoverview Runtime validation/normalization for scraper API responses.
 *
 * ScraperConfig declares every field required, but runtime payloads have
 * delivered sparse records (issue #167: missing base_url crashed the route;
 * issue #169: missing frequency_minutes rendered 'undefinedm', and the
 * status endpoint's drifted shape rendered 'Last: pages, reviews' with the
 * counts blank). Following the project convention (see api/feedbackSchema.ts,
 * pages/FeedbackForms/formSchema.ts), lenient Zod schemas make the declared
 * contracts true at this boundary: invalid or missing fields degrade to
 * conservative defaults instead of rejecting the record.
 *
 * Wire defaults are deliberately NOT the editor's DEFAULT_SCRAPER values:
 * the editor seeds ergonomic starting values for a scraper the user is about
 * to create (daily schedule, enabled), while the normalizer must describe an
 * existing record truthfully — a record with no schedule is 'Manual only'
 * (0), not 'Daily', and a record that never said enabled stays disabled.
 *
 * @module api/scrapersSchema
 */
import { z } from 'zod'
import type { ScraperConfig } from './types'

/** Coerce DynamoDB string round-trips like "30" to numbers; null/'' become
 * undefined so the field-level catch supplies the default instead of 0. */
function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Keep string items, drop junk elements instead of discarding the array. */
const stringArraySchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) => items.filter((item): item is string => typeof item === 'string'))

// Per-field catches survive a partial pagination object; the object-level
// catch covers pagination: null/absent wholesale.
const paginationSchema = z
  .object({
    enabled: z.boolean().catch(false),
    param: z.string().catch('page'),
    max_pages: z.preprocess(toOptionalFiniteNumber, z.number().catch(1)),
    start: z.preprocess(toOptionalFiniteNumber, z.number().catch(1)),
  })
  .catch(() => ({ enabled: false, param: 'page', max_pages: 1, start: 1 }))

const optionalString = z.string().optional().catch(undefined)

/**
 * Schema for a stored scraper config.
 *
 * - Loose object: unknown backend fields (created_at, future additions)
 *   pass through untouched, so a record read from getScrapers() and saved
 *   back by the editor round-trips without silent data loss.
 * - id is the one field that CANNOT be invented: it feeds React list keys
 *   and the status-polling endpoint, so records without a usable id are
 *   dropped (with a warning) by normalizeScrapers.
 * - frequency_minutes defaults to 0 ('Manual only') — the truthful reading
 *   of a record with no schedule; anything else would claim runs that
 *   never happen ('undefinedm' was the rendered symptom, issue #169).
 * - base_url defaults to '' (the card's not-configured state, issue #167).
 */
export const ScraperConfigSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().catch(''),
  enabled: z.boolean().catch(false),
  base_url: z.string().catch(''),
  urls: stringArraySchema,
  frequency_minutes: z.preprocess(toOptionalFiniteNumber, z.number().catch(0)),
  // Must grow in lockstep with the backend's supported methods: an unknown
  // method degrades to undefined (renderable), not a dropped record.
  extraction_method: z.enum(['css', 'jsonld']).optional().catch(undefined),
  template: optionalString,
  container_selector: z.string().catch(''),
  text_selector: z.string().catch(''),
  title_selector: optionalString,
  rating_selector: optionalString,
  rating_attribute: optionalString,
  date_selector: optionalString,
  author_selector: optionalString,
  link_selector: optionalString,
  pagination: paginationSchema,
  last_run: optionalString,
  items_found: z.preprocess(toOptionalFiniteNumber, z.number().optional().catch(undefined)),
})

/**
 * Normalize a wire list for rendering: records without a usable id are
 * dropped with a warning instead of inventing identity — '' ids would
 * collide React list keys and poll a nonsense status endpoint.
 */
export function normalizeScrapers(rawScrapers: readonly unknown[]): ScraperConfig[] {
  return rawScrapers.flatMap((raw) => {
    const parsed = ScraperConfigSchema.safeParse(raw)
    if (!parsed.success) {
      // Issues only — no raw payload, which may carry config the user
      // considers internal (URLs, selectors).
      console.warn('Dropping scraper record that failed schema validation:', parsed.error.issues)
      return []
    }
    return [parsed.data]
  })
}

/**
 * Schema for a scraper run status. status stays a plain string (unknown
 * future statuses render as a benign amber badge rather than being
 * misreported); a missing status means 'never_run', which the card treats
 * as nothing-to-show. Counts degrade to 0 so the last-run summary renders
 * '0 pages, 0 reviews' instead of 'pages, reviews' (issue #169). The
 * object-level catch makes even a non-object response (null, an error
 * string body) degrade to never_run — same philosophy, never throw.
 */
export const ScraperRunStatusSchema = z
  .object({
    scraper_id: optionalString,
    execution_id: optionalString,
    status: z.string().catch('never_run'),
    started_at: optionalString,
    completed_at: optionalString,
    pages_scraped: z.preprocess(toOptionalFiniteNumber, z.number().catch(0)),
    items_found: z.preprocess(toOptionalFiniteNumber, z.number().catch(0)),
    errors: stringArraySchema,
  })
  .catch(() => ({
    scraper_id: undefined,
    execution_id: undefined,
    status: 'never_run',
    started_at: undefined,
    completed_at: undefined,
    pages_scraped: 0,
    items_found: 0,
    errors: [],
  }))

export type ScraperRunStatus = z.infer<typeof ScraperRunStatusSchema>

/** Make the declared run-status contract true for one wire response.
 * Total: even a non-object response degrades to never_run. */
export function normalizeScraperRunStatus(raw: unknown): ScraperRunStatus {
  return ScraperRunStatusSchema.parse(raw)
}
