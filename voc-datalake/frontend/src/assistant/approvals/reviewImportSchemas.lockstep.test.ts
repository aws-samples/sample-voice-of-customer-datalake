/**
 * LOCKSTEP: the `import_reviews` approval boundary (./reviewImportSchemas) ⇄ the
 * stream Lambda's (`lambda/stream/src/assistant/tools/client/review-import-schemas.ts`)
 * ⇄ what the route and the processing queue accept
 * (`lambda/api/manual_import_handler.py`, `lambda/shared/ingest_schemas.py`).
 * The stream module is imported directly; the Python bounds are read as TEXT.
 * A bound accepted by one side only would mean a card the server proposes but
 * the SPA refuses — or rows the queue rejects after the user approved them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_IMPORT_SOURCE_ID, SPA_REVIEW_IMPORT_LIMITS, importReviewsArgs, isReviewDate, reviewItemArgs } from './reviewImportSchemas'
// Self-contained (zod + the user-schemas module, zod only), like the user tools' lockstep.
import * as stream from '../../../../lambda/stream/src/assistant/tools/client/review-import-schemas'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const manualImport = read('lambda/api/manual_import_handler.py')
const ingestSchemas = read('lambda/shared/ingest_schemas.py')
const ingestArchive = read('lambda/shared/ingest_archive.py')

/** The first capture of `pattern` in `source`, as a number (Python digit separators dropped). */
function pythonNumber(source: string, pattern: string, what: string): number {
  const captured = new RegExp(pattern, 'm').exec(source)?.[1]
  if (captured === undefined) throw new Error(`${what} not found`)
  return Number(captured.replaceAll('_', ''))
}

/** `NAME = <int>` (or `NAME: Final = <int>`) at the start of a line. */
const pythonInt = (source: string, name: string) => pythonNumber(source, `^${name}(?:: Final)? = ([\\d_]+)`, name)
/** The `max_length` of an IngestMessage field declared `<field>: str | None = Field(None, max_length=<n>)`. */
const ingestFieldMax = (field: string) =>
  pythonNumber(ingestSchemas, `^    ${field}: str \\| None = Field\\(None, max_length=(\\d+)\\)`, `IngestMessage.${field}`)

/** A zod object's keys in a stable order. */
const keysOf = (schema: { shape: object }) => Object.keys(schema.shape).sort((a, b) => a.localeCompare(b))

describe('import_reviews: stream ⇄ SPA', () => {
  it('the same limits, default source and argument shape', () => {
    expect({ ...stream.REVIEW_IMPORT_LIMITS }).toStrictEqual({ ...SPA_REVIEW_IMPORT_LIMITS })
    expect(stream.DEFAULT_IMPORT_SOURCE_ID).toBe(DEFAULT_IMPORT_SOURCE_ID)
    expect(keysOf(importReviewsArgs)).toStrictEqual(keysOf(stream.importReviewsArgsSchema))
    expect(keysOf(reviewItemArgs)).toStrictEqual(keysOf(stream.importReviewsArgsSchema.shape.items.element))
  })

  it.each([
    '2026-03-01', '2026-03-01T09:30', '2026-03-01T09:30:00Z', '2026-03-01T09:30:00.123456+05:30',
    '2026-13-01', '2026-03-01T9:30', '2026-03-01T09:30.5', 'March 1', '2026-03-01T09:30:00T1',
  ])('both sides judge the date %j the same', (value) => {
    const args = { source_name: 'S', items: [{ text: 't', created_at: value }] }
    expect(stream.importReviewsArgsSchema.safeParse(args).success).toBe(isReviewDate(value))
  })
})

describe('import_reviews: SPA ⇄ the route and the queue', () => {
  it('a card stays inside the json-upload item cap and the manual-import paste limit', () => {
    expect(SPA_REVIEW_IMPORT_LIMITS.maxItems).toBeLessThanOrEqual(pythonInt(manualImport, 'MAX_JSON_UPLOAD_ITEMS'))
    expect(SPA_REVIEW_IMPORT_LIMITS.maxTextChars).toBe(pythonInt(manualImport, 'MAX_CHARACTERS'))
    expect(SPA_REVIEW_IMPORT_LIMITS.maxTextChars).toBeLessThanOrEqual(pythonInt(ingestSchemas, 'MAX_TEXT_LENGTH'))
  })

  it('the per-field bounds are IngestMessage\u2019s', () => {
    expect(SPA_REVIEW_IMPORT_LIMITS.maxSourceNameChars).toBe(pythonInt(ingestSchemas, 'MAX_SOURCE_CHANNEL_LENGTH'))
    expect(SPA_REVIEW_IMPORT_LIMITS.maxUrlChars).toBe(pythonInt(ingestSchemas, 'MAX_URL_LENGTH'))
    expect(SPA_REVIEW_IMPORT_LIMITS.maxRating).toBe(pythonInt(ingestSchemas, 'MAX_RATING'))
    expect([SPA_REVIEW_IMPORT_LIMITS.maxAuthorChars, SPA_REVIEW_IMPORT_LIMITS.maxTitleChars]).toStrictEqual([ingestFieldMax('author'), ingestFieldMax('title')])
  })

  it('the rating floor and the default source are the queue\u2019s and the upload\u2019s', () => {
    expect(ingestSchemas).toContain(`rating: float | None = Field(None, ge=${String(SPA_REVIEW_IMPORT_LIMITS.minRating)}, le=MAX_RATING)`)
    expect(ingestArchive).toContain(`DEFAULT_UPLOAD_SOURCE: Final = '${DEFAULT_IMPORT_SOURCE_ID}'`)
  })
})
