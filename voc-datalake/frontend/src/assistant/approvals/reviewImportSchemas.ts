/**
 * @fileoverview The SPA approval boundary of `import_reviews` (scrapers pack,
 * admin-only) and the pure builders its card and executor share, so the card
 * shows exactly what is imported.
 *
 * The limits and the argument shape are the stream Lambda's
 * (`@stream/assistant/tools/client/review-import-schemas`, which pins them to
 * what `POST /scrapers/manual/json-upload` and the processing queue accept);
 * this file adds the card's own total-text message.
 *
 * @module assistant/approvals/reviewImportSchemas
 */
import { z } from 'zod'
import { REVIEW_IMPORT_LIMITS, importReviewsArgsShape, withinTotalText } from '@stream/assistant/tools/client/review-import-schemas'

export const importReviewsArgs = z.strictObject({
  ...importReviewsArgsShape,
  items: importReviewsArgsShape.items.refine(
    withinTotalText,
    `the reviews' text must total at most ${String(REVIEW_IMPORT_LIMITS.maxTotalTextChars)} characters`,
  ),
})

type ReviewItem = ImportReviewsArgs['items'][number]
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
