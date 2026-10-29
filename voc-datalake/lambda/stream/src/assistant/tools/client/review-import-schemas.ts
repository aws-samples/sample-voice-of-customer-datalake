/**
 * Argument schema of `import_reviews` (`scrapers` pack, admin-only): reviews the
 * model extracted from pasted text or an attached file, imported through the
 * existing `POST /scrapers/manual/json-upload` route.
 *
 * Bounds mirror what that route and the processing queue accept, narrower where
 * one approval card has to stay readable:
 *   - `maxItems` 500 per card (the route takes `MAX_JSON_UPLOAD_ITEMS` = 50,000);
 *   - `maxTextChars` = `manual_import_handler.MAX_CHARACTERS`, the paste limit of
 *     manual import; `maxTotalTextChars` keeps one tool call inside the model's
 *     output and the saved session;
 *   - `source_name` (the item's `source`, stored as `source_channel`), `author`,
 *     `title`, `url` and `rating` are `shared/ingest_schemas.IngestMessage`'s
 *     bounds (`MAX_SOURCE_CHANNEL_LENGTH`, 256, 500, `MAX_URL_LENGTH`, 1..`MAX_RATING`);
 *   - `source_id` is the source profile the rows are filed under (body
 *     `source_id`; `shared/ingest_archive.upload_profile`), the source-profile id rule.
 *
 * LOCKSTEP: `frontend/src/assistant/approvals/reviewImportSchemas.ts` holds the
 * same limits and argument shape; `reviewImportSchemas.lockstep.test.ts` reads
 * this file and the Python constants and fails when they drift.
 */
import { z } from 'zod';
import { optionalNonEmpty } from './text-schemas.js';
import { SOURCE_ID_PATTERN } from './user-schemas.js';

/** The source profile json-upload files rows under when the body names none (`ingest_archive.DEFAULT_UPLOAD_SOURCE`). */
export const DEFAULT_IMPORT_SOURCE_ID = 'manual_import';

export const REVIEW_IMPORT_LIMITS = {
  maxItems: 500,
  maxTextChars: 10_000,
  maxTotalTextChars: 200_000,
  maxSourceNameChars: 128,
  maxAuthorChars: 256,
  maxTitleChars: 500,
  maxUrlChars: 4096,
  minRating: 1,
  maxRating: 10,
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CLOCK = /^(?:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})$/;
const ISO_FRACTION = /^\d{1,6}$/;
const ISO_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/;
/** `HH:MM:SS` — only a clock with seconds may carry a fraction. */
const CLOCK_WITH_SECONDS_CHARS = 8;

/**
 * A calendar date (`YYYY-MM-DD`), or a date-time `YYYY-MM-DDTHH:MM[:SS[.ffffff]][Z|±HH:MM]` —
 * what IngestMessage.created_at parses — that is also a real date.
 */
function isReviewDate(value: string): boolean {
  const [date = '', time, ...rest] = value.split('T');
  if (!ISO_DATE.test(date) || rest.length > 0) return false;
  if (time !== undefined && !isClockTime(time.replace(ISO_ZONE, ''))) return false;
  return !Number.isNaN(Date.parse(date));
}

/** `HH:MM`, `HH:MM:SS` or `HH:MM:SS.ffffff` (up to six fraction digits). */
function isClockTime(value: string): boolean {
  const [clock = '', fraction, ...rest] = value.split('.');
  if (rest.length > 0 || !ISO_CLOCK.test(clock)) return false;
  return fraction === undefined || (clock.length === CLOCK_WITH_SECONDS_CHARS && ISO_FRACTION.test(fraction));
}

const L = REVIEW_IMPORT_LIMITS;

const reviewItemSchema = z.object({
  text: z.string().trim().min(1).max(L.maxTextChars),
  rating: z.number().min(L.minRating).max(L.maxRating).optional(),
  author: optionalNonEmpty(L.maxAuthorChars),
  created_at: z.string().trim().refine(isReviewDate, 'must be an ISO 8601 date (YYYY-MM-DD) or date-time').optional(),
  url: z.url({ protocol: /^https?$/ }).max(L.maxUrlChars).optional(),
  title: optionalNonEmpty(L.maxTitleChars),
}).strict();

export const importReviewsArgsSchema = z.object({
  source_name: z.string().trim().min(1).max(L.maxSourceNameChars),
  source_id: z.string().trim().regex(SOURCE_ID_PATTERN, 'must be a configured source profile id').optional(),
  items: z.array(reviewItemSchema).min(1).max(L.maxItems).refine(
    (items) => items.reduce((sum, item) => sum + item.text.length, 0) <= L.maxTotalTextChars,
    `the reviews' text must total at most ${L.maxTotalTextChars} characters; split the import into several cards`,
  ),
}).strict();

