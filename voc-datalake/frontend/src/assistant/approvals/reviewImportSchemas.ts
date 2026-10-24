/**
 * @fileoverview The SPA approval boundary of `import_reviews` (scrapers pack,
 * admin-only) and the pure builders its card and executor share, so the card
 * shows exactly what is imported.
 *
 * Limits are IDENTICAL to the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/review-import-schemas.ts`) and to
 * what `POST /scrapers/manual/json-upload` and the processing queue accept;
 * `reviewImportSchemas.lockstep.test.ts` compares all three.
 *
 * @module assistant/approvals/reviewImportSchemas
 */
import { z } from 'zod'
import { SOURCE_ID_PATTERN } from './userSchemas'

export const SPA_REVIEW_IMPORT_LIMITS = {
  // per card
  maxItems: 500, maxTotalTextChars: 200_000,
  // per review
  maxTextChars: 10_000, maxTitleChars: 500, maxAuthorChars: 256, maxUrlChars: 4096, minRating: 1, maxRating: 10,
  // per source
  maxSourceNameChars: 128,
} as const

/** The source profile json-upload files rows under when the body names none. */
export const DEFAULT_IMPORT_SOURCE_ID = 'manual_import'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_CLOCK = /^(?:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})$/
const ISO_FRACTION = /^\d{1,6}$/
const ISO_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/
/** `HH:MM:SS` — only a clock with seconds may carry a fraction. */
const CLOCK_WITH_SECONDS_CHARS = 8

/** `HH:MM`, `HH:MM:SS` or `HH:MM:SS.ffffff`. */
function isClockTime(value: string): boolean {
  const [clock = '', fraction, ...rest] = value.split('.')
  if (rest.length > 0 || !ISO_CLOCK.test(clock)) return false
  return fraction === undefined || (clock.length === CLOCK_WITH_SECONDS_CHARS && ISO_FRACTION.test(fraction))
}

/** A real calendar date (`YYYY-MM-DD`), or a date-time `YYYY-MM-DDTHH:MM[:SS[.ffffff]][Z|±HH:MM]`. */
export function isReviewDate(value: string): boolean {
  const [date = '', time, ...rest] = value.split('T')
  if (!ISO_DATE.test(date) || rest.length > 0) return false
  if (time !== undefined && !isClockTime(time.replace(ISO_ZONE, ''))) return false
  return !Number.isNaN(Date.parse(date))
}

const L = SPA_REVIEW_IMPORT_LIMITS
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional()

const ratingArg = z.number().min(L.minRating).max(L.maxRating)
const dateArg = z.string().trim().refine(isReviewDate, 'must be an ISO 8601 date (YYYY-MM-DD) or date-time')
const urlArg = z.url({ protocol: /^https?$/ }).max(L.maxUrlChars)

/** One review row; every field but `text` is optional (the source may not give it). */
export const reviewItemArgs = z.strictObject({
  text: z.string().trim().min(1).max(L.maxTextChars),
  title: optionalText(L.maxTitleChars),
  author: optionalText(L.maxAuthorChars),
  rating: ratingArg.optional(),
  created_at: dateArg.optional(),
  url: urlArg.optional(),
})

export const importReviewsArgs = z.strictObject({
  source_name: z.string().trim().min(1).max(L.maxSourceNameChars),
  source_id: z.string().trim().regex(SOURCE_ID_PATTERN, 'must be a configured source profile id').optional(),
  items: z.array(reviewItemArgs).min(1).max(L.maxItems).refine(
    (items) => items.reduce((sum, item) => sum + item.text.length, 0) <= L.maxTotalTextChars,
    `the reviews' text must total at most ${String(L.maxTotalTextChars)} characters`,
  ),
})

export type ReviewItem = z.infer<typeof reviewItemArgs>
export type ImportReviewsArgs = z.infer<typeof importReviewsArgs>

/** What the card counts: rows, and how many carry a rating / a date. */
export function importStats(args: ImportReviewsArgs): { total: number; rated: number; dated: number } {
  return {
    total: args.items.length,
    rated: args.items.filter((item) => item.rating !== undefined).length,
    dated: args.items.filter((item) => item.created_at !== undefined).length,
  }
}

/** Prefix of the de-duplication ids, versioned: the recipe below is persisted in every stored id. */
const IMPORT_ID_VERSION = 'ai-import-v1'
/** Hex characters of the digest kept (160 bits) — well inside the queue's 256-character id. */
const IMPORT_ID_HASH_CHARS = 40

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A row's id: sha256 over the source name and the row's own text, author and
 * date (not the import time), so the same review imported twice is stored once.
 */
export async function reviewImportId(sourceName: string, item: ReviewItem): Promise<string> {
  const identity = JSON.stringify([IMPORT_ID_VERSION, sourceName, item.text, item.author ?? '', item.created_at ?? ''])
  return `${IMPORT_ID_VERSION}-${(await sha256Hex(identity)).slice(0, IMPORT_ID_HASH_CHARS)}`
}

/** The json-upload items: each row with its id, its channel and a date (`importedAt` when it has none). */
export async function jsonUploadItems(args: ImportReviewsArgs, importedAt: string): Promise<Record<string, unknown>[]> {
  return Promise.all(args.items.map(async (item) => ({
    id: await reviewImportId(args.source_name, item),
    source: args.source_name,
    text: item.text,
    timestamp: item.created_at ?? importedAt,
    ...(item.rating === undefined ? {} : { rating: item.rating }),
    ...(item.author === undefined ? {} : { author: item.author }),
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.url === undefined ? {} : { url: item.url }),
  })))
}
