/**
 * The scraper and app-connector records a write saves — the stream side of the
 * SPA's `frontend/src/assistant/approvals/scraperSchemas.ts` record builders
 * (`createdScraperRecord`, `mergedScraperRecord`, `scraperRecordProblem`,
 * `appConnectorRecord`), so a plan step saves what the approval card would.
 */
import {
  APP_CONNECTOR_DEFAULTS, APP_ID_FIELD, type AppConnectorSource, SCRAPER_LIMITS, WEB_REVIEW_PAGES, WEB_REVIEW_REVIEWS,
} from '../tools/client/scraper-schemas.js';
import { isRecord } from '../../lib/is-record.js';
import { defined, optionalNumber, optionalText, record, text, type Args } from './write-args.js';

type ScraperRecord = Record<string, unknown>;

const DEFAULT_PAGINATION = { enabled: false, param: 'page', max_pages: 1, start: 1 } as const;

function paginationOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ── The stored scraper as the SPA reads it ─────────────────────────────────

const OPTIONAL_TEXT_FIELDS = [
  'template', 'title_selector', 'rating_selector', 'rating_attribute', 'date_selector', 'author_selector', 'link_selector', 'last_run',
] as const;
const EXTRACTION_METHOD_VALUES: ReadonlySet<unknown> = new Set(['css', 'jsonld']);

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const textOr = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

function storedPagination(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { ...DEFAULT_PAGINATION };
  return {
    ...value,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    param: textOr(value.param, 'page'),
    max_pages: finiteNumber(value.max_pages) ?? 1,
    start: finiteNumber(value.start) ?? 1,
  };
}

/**
 * A stored scraper normalised exactly as the SPA reads it before an update merges into it
 * (`frontend/src/api/scrapersSchema.ts` `normalizeScrapers`): unknown fields pass through,
 * a missing or malformed required field takes its truthful default (off, manual only, no
 * selectors), a malformed optional field is dropped. So a sparse legacy record saves the same
 * record from a card and from a plan step.
 */
export function storedScraperRecord(raw: Record<string, unknown>): ScraperRecord {
  const optional = Object.fromEntries(OPTIONAL_TEXT_FIELDS.filter((key) => key in raw && typeof raw[key] !== 'string').map((key) => [key, undefined]));
  const items = finiteNumber(raw.items_found);
  const normalized: ScraperRecord = {
    ...raw,
    ...optional,
    name: textOr(raw.name, ''),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    base_url: textOr(raw.base_url, ''),
    urls: Array.isArray(raw.urls) ? raw.urls.filter((url) => typeof url === 'string') : [],
    frequency_minutes: finiteNumber(raw.frequency_minutes) ?? 0,
    container_selector: textOr(raw.container_selector, ''),
    text_selector: textOr(raw.text_selector, ''),
    pagination: storedPagination(raw.pagination),
    ...('extraction_method' in raw && !EXTRACTION_METHOD_VALUES.has(raw.extraction_method) ? { extraction_method: undefined } : {}),
    ...('items_found' in raw ? { items_found: items } : {}),
  };
  // As the SPA's JSON body: a field normalised to undefined is not sent.
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

/** What a create saves for each omitted field: OFF (disabled, manual runs only, no selectors). */
const CREATE_DEFAULTS = { enabled: false, base_url: '', urls: [], frequency_minutes: 0, container_selector: '', text_selector: '' } as const;

/** The complete record a create saves: omitted fields take their OFF defaults (disabled, manual runs only). */
export function createdScraperRecord(args: Args): ScraperRecord {
  const { pagination, ...rest } = defined(args);
  return { ...CREATE_DEFAULTS, ...rest, pagination: { ...DEFAULT_PAGINATION, ...paginationOf(pagination) } };
}

/** The stored scraper with the proposed fields replacing theirs (pagination merged key by key). */
export function mergedScraperRecord(base: ScraperRecord, args: Args): ScraperRecord {
  const { pagination, ...rest } = record(args, 'updates');
  return { ...base, ...rest, pagination: { ...paginationOf(base.pagination), ...paginationOf(pagination) } };
}

const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

/** Why `scraper` must not be saved (css without selectors, over the size budget), else undefined. */
export function scraperRecordProblem(scraper: ScraperRecord): string | undefined {
  if (scraper.extraction_method === 'css' && (blank(scraper.container_selector) || blank(scraper.text_selector))) {
    return 'A css scraper needs container_selector and text_selector.';
  }
  if (new TextEncoder().encode(JSON.stringify(scraper)).length > SCRAPER_LIMITS.maxScraperBytes) {
    return `A scraper config may be at most ${SCRAPER_LIMITS.maxScraperBytes} bytes.`;
  }
  return undefined;
}

const DEFAULT_SORT = { app_reviews_ios: 'most_recent', app_reviews_android: 'newest' } as const;

export function appConnectorSource(args: Args): AppConnectorSource {
  const source = text(args, 'source');
  if (source === 'app_reviews_ios' || source === 'web_reviews') return source;
  return 'app_reviews_android';
}

/** The config a create saves (string values, as the route stores them; the server mints the id). */
export function appConnectorRecord(args: Args): Record<string, string> {
  const source = appConnectorSource(args);
  const frequency = String(optionalNumber(args, 'frequency_minutes') ?? APP_CONNECTOR_DEFAULTS.frequencyMinutes);
  if (source === 'web_reviews') {
    return {
      app_name: text(args, 'app_name'),
      url: optionalText(args, 'url') ?? '',
      max_pages: String(optionalNumber(args, 'max_pages') ?? WEB_REVIEW_PAGES.default),
      max_reviews: String(optionalNumber(args, 'max_reviews') ?? WEB_REVIEW_REVIEWS.default),
      frequency_minutes: frequency,
      ...radarField(optionalText(args, 'radar_brand')),
    };
  }
  const idField = APP_ID_FIELD[source];
  return {
    app_name: text(args, 'app_name'),
    [idField]: optionalText(args, idField) ?? '',
    sort_by: optionalText(args, 'sort_by') ?? DEFAULT_SORT[source],
    max_reviews_per_run: String(optionalNumber(args, 'max_reviews_per_run') ?? APP_CONNECTOR_DEFAULTS.maxReviewsPerRun),
    frequency_minutes: frequency,
    ...radarField(optionalText(args, 'radar_brand')),
  };
}

/** `radar_brand` on a connector record only when set (absent = an ordinary source), as the SPA saves it. */
function radarField(key: string | undefined): Record<string, string> {
  return key === undefined || key === '' ? {} : { radar_brand: key };
}
