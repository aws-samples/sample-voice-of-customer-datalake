/**
 * The `import_reviews` bounds (`review-import-schemas.ts`, also the SPA's approval boundary through
 * `@stream`) against what the route and the processing queue accept (`lambda/api/manual_import_handler.py`,
 * `lambda/shared/ingest_schemas.py`, `lambda/shared/ingest_archive.py`), read as text. A bound looser than
 * the queue's would mean rows it rejects after the user approved them.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPORT_SOURCE_ID, REVIEW_IMPORT_LIMITS as L, importReviewsArgsSchema, importReviewsArgsShape, withinTotalText,
} from './review-import-schemas.js';

/** The Python sources, by path under `lambda/` (vitest reads them at transform time). */
const PYTHON = import.meta.glob<string>(
  '../../../../../{api/manual_import_handler,shared/ingest_schemas,shared/ingest_archive}.py',
  { eager: true, query: '?raw', import: 'default' },
);
function python(path: string): string {
  const text = PYTHON[`../../../../../${path}`];
  if (text === undefined) throw new Error(`${path} not loaded`);
  return text;
}
const manualImport = python('api/manual_import_handler.py');
const ingestSchemas = python('shared/ingest_schemas.py');
const ingestArchive = python('shared/ingest_archive.py');

/** The first capture of `pattern` in `source`, as a number (Python digit separators dropped). */
function pythonNumber(source: string, pattern: string, what: string): number {
  const captured = new RegExp(pattern, 'm').exec(source)?.[1];
  if (captured === undefined) throw new Error(`${what} not found`);
  return Number(captured.replaceAll('_', ''));
}

/** `NAME = <int>` (or `NAME: Final = <int>`) at the start of a line. */
const pythonInt = (source: string, name: string) => pythonNumber(source, `^${name}(?:: Final)? = ([\\d_]+)`, name);
/** The `max_length` of an IngestMessage field declared `<field>: str | None = Field(None, max_length=<n>)`. */
const ingestFieldMax = (field: string) =>
  pythonNumber(ingestSchemas, `^    ${field}: str \\| None = Field\\(None, max_length=(\\d+)\\)`, `IngestMessage.${field}`);

describe('import_reviews bounds ⇄ the route and the queue', () => {
  it('a card stays inside the json-upload item cap and the manual-import paste limit', () => {
    expect(L.maxItems).toBeLessThanOrEqual(pythonInt(manualImport, 'MAX_JSON_UPLOAD_ITEMS'));
    expect(L.maxTextChars).toBe(pythonInt(manualImport, 'MAX_CHARACTERS'));
    expect(L.maxTextChars).toBeLessThanOrEqual(pythonInt(ingestSchemas, 'MAX_TEXT_LENGTH'));
  });

  it('the per-field bounds are IngestMessage’s', () => {
    expect(L.maxSourceNameChars).toBe(pythonInt(ingestSchemas, 'MAX_SOURCE_CHANNEL_LENGTH'));
    expect(L.maxUrlChars).toBe(pythonInt(ingestSchemas, 'MAX_URL_LENGTH'));
    expect(L.maxRating).toBe(pythonInt(ingestSchemas, 'MAX_RATING'));
    expect([L.maxAuthorChars, L.maxTitleChars]).toStrictEqual([ingestFieldMax('author'), ingestFieldMax('title')]);
  });

  it('the rating floor and the default source are the queue’s and the upload’s', () => {
    expect(ingestSchemas).toContain(`rating: float | None = Field(None, ge=${String(L.minRating)}, le=MAX_RATING)`);
    expect(ingestArchive).toContain(`DEFAULT_UPLOAD_SOURCE: Final = '${DEFAULT_IMPORT_SOURCE_ID}'`);
  });
});

describe('import_reviews argument shape', () => {
  it('names the source and the rows, in that order', () => {
    expect(Object.keys(importReviewsArgsShape)).toStrictEqual(['source_name', 'source_id', 'items']);
  });

  it('caps the rows\u2019 total text at maxTotalTextChars', () => {
    const half = 'x'.repeat(L.maxTotalTextChars / 2);
    expect(withinTotalText([{ text: half }, { text: half }])).toBe(true);
    expect(withinTotalText([{ text: half }, { text: `${half}x` }])).toBe(false);
  });
});

describe('import_reviews dates', () => {
  it.each([
    ['2026-03-01', true], ['2026-03-01T09:30', true], ['2026-03-01T09:30:00Z', true], ['2026-03-01T09:30:00.123456+05:30', true],
    ['2026-13-01', false], ['2026-03-01T9:30', false], ['2026-03-01T09:30.5', false], ['March 1', false], ['2026-03-01T09:30:00T1', false],
  ])('judges %j as a review date: %s', (value, ok) => {
    const args = { source_name: 'S', items: [{ text: 't', created_at: value }] };
    expect(importReviewsArgsSchema.safeParse(args).success).toBe(ok);
  });
});
