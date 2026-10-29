/**
 * Argument schemas of the connector write tools (`scrapers` pack):
 * `create_scraper`, `update_scraper` and `create_app_connector`, plus the
 * public-URL rule `analyze_scraper_url` shares.
 *
 * Bounds mirror what the routes validate, narrower where the two differ:
 *   - scrapers: `lambda/api/scrapers_handler.py` `_scraper_shape_error`
 *     (id pattern, text fields ≤ 500, ≤ 25 urls of ≤ 2048 chars, pagination
 *     bounds, `frequency_minutes` 0–43,200, ≤ 8 KiB per config) and
 *     `_scraper_url_error` (`shared/url_policy.validate_url`). Here a URL must
 *     also be https, name a dotted host that is not an IP literal or localhost,
 *     and carry no credentials — the route re-checks with DNS resolution;
 *   - app connectors: `integrations_handler.save_app_config` (requires
 *     `app_name`) and the manifests of `plugins/app_reviews_{ios,android}`
 *     (identifier field, sort orders, frequency options).
 *
 * `radar_brand` (all three tools): the key of a Radar brand (GET /radar/brands,
 * docs/radar.md); its reviews then go to Radar, never to our own feedback. An
 * update may clear it with '' (an ordinary source again). The tools' prechecks
 * refuse a key no brand has (`./radar.ts`).
 *
 * LOCKSTEP: the SPA boundary (`frontend/src/assistant/approvals/
 * scraperSchemas.ts`) holds the same limits and enums;
 * `scraperSchemas.lockstep.test.ts` reads this file (and scrapers_handler.py) as
 * text and fails when they drift.
 */
import { z } from 'zod';
import { dimensionDefaultsSchema, labelTagsSchema } from './allowlists.js';

export const SCRAPER_LIMITS = {
  maxUrls: 25,
  maxUrlLength: 2048,
  maxTextField: 500,
  maxPaginationParam: 64,
  maxPages: 50,
  maxPaginationStart: 10_000,
  maxFrequencyMinutes: 43_200,
  maxScraperBytes: 8192,
} as const;

/** shared.row_ids.OPAQUE_ID_RE (scrapers_handler). */
const SCRAPER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SCRAPER_ID_LENGTH = 64;

const EXTRACTION_METHODS = ['css', 'jsonld'] as const;

/** A Radar brand key on a scraper or connector (shared/radar_brands.brand_key, ASCII slugs). */
const RADAR_BRAND_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const radarBrandKeySchema = z.string().trim().regex(RADAR_BRAND_KEY_PATTERN, 'must be a Radar brand key from get_radar view "brands"');

/** The selector text fields of scrapers_handler.TEXT_FIELDS (`name` and `template` aside). */
export const SCRAPER_SELECTOR_FIELDS = [
  'container_selector', 'text_selector', 'title_selector', 'rating_selector', 'rating_attribute',
  'date_selector', 'author_selector', 'link_selector',
] as const;

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
const DIGITS = /^\d+$/;

/** WHATWG URL parsing already normalises every IPv4 spelling to dotted decimal. */
function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => DIGITS.test(part));
}

/** Why `value` is not a public https URL the route would accept, else undefined. */
export function publicUrlProblem(value: string): string | undefined {
  if (!URL.canParse(value)) return 'must be an absolute URL';
  const url = new URL(value);
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username !== '' || url.password !== '') return 'must not embed credentials';
  const host = url.hostname.replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) return 'must not point at localhost';
  if (host.startsWith('[') || isIpv4Literal(host)) return 'must use a host name, not an IP address';
  if (!host.includes('.')) return 'must use a fully qualified public host name';
  return undefined;
}

export const publicUrlSchema = z.string().trim().max(SCRAPER_LIMITS.maxUrlLength).superRefine((value, ctx) => {
  const problem = publicUrlProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: `URL ${problem}` });
});

const textField = z.string().trim().max(SCRAPER_LIMITS.maxTextField);
/** Typed per key (an `Object.fromEntries` map would erase the field names). */
const selectorShape = {
  container_selector: textField.optional(),
  text_selector: textField.optional(),
  title_selector: textField.optional(),
  rating_selector: textField.optional(),
  rating_attribute: textField.optional(),
  date_selector: textField.optional(),
  author_selector: textField.optional(),
  link_selector: textField.optional(),
} satisfies Record<(typeof SCRAPER_SELECTOR_FIELDS)[number], z.ZodType>;

const paginationSchema = z.object({
  enabled: z.boolean(),
  param: z.string().trim().min(1).max(SCRAPER_LIMITS.maxPaginationParam).optional(),
  max_pages: z.number().int().min(1).max(SCRAPER_LIMITS.maxPages).optional(),
  start: z.number().int().min(0).max(SCRAPER_LIMITS.maxPaginationStart).optional(),
}).strict();

/** The editable fields, all optional (an update's `updates`; a create adds `id` and its rules). */
const scraperFieldsShape = {
  name: z.string().trim().min(1).max(SCRAPER_LIMITS.maxTextField).optional(),
  base_url: publicUrlSchema.optional(),
  urls: z.array(publicUrlSchema).max(SCRAPER_LIMITS.maxUrls).optional(),
  extraction_method: z.enum(EXTRACTION_METHODS).optional(),
  ...selectorShape,
  pagination: paginationSchema.optional(),
  frequency_minutes: z.number().int().min(0).max(SCRAPER_LIMITS.maxFrequencyMinutes).optional(),
  enabled: z.boolean().optional(),
  dimension_defaults: dimensionDefaultsSchema.optional(),
  tags: labelTagsSchema.optional(),
  /** '' clears it (an update turning a Radar source back into an ordinary one). */
  radar_brand: radarBrandKeySchema.or(z.literal('')).optional(),
};

const encoder = new TextEncoder();

/** Serialized size in bytes, as the route measures it (`json.dumps(scraper).encode()`, near enough). */
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** A css scraper finds nothing without both of these (the ingestor's container + text). */
function hasSelectors(fields: { container_selector?: string; text_selector?: string }): boolean {
  return Boolean(fields.container_selector?.trim()) && Boolean(fields.text_selector?.trim());
}

const scraperIdSchema = z.string().regex(SCRAPER_ID_PATTERN, 'must be 1-64 letters, digits, "_" or "-"');

/** A create: `name` and `extraction_method` become required, plus at least one URL. */
export const createScraperArgsSchema = z.object({
  id: scraperIdSchema,
  ...scraperFieldsShape,
  name: z.string().trim().min(1).max(SCRAPER_LIMITS.maxTextField),
  extraction_method: z.enum(EXTRACTION_METHODS),
  radar_brand: radarBrandKeySchema.optional(),
}).strict()
  .refine((args) => Boolean(args.base_url) || (args.urls ?? []).length > 0, 'give base_url or at least one url')
  .refine((args) => args.extraction_method !== 'css' || hasSelectors(args), 'css scrapers need container_selector and text_selector')
  .refine((args) => jsonBytes(args) <= SCRAPER_LIMITS.maxScraperBytes, `a scraper config may be at most ${SCRAPER_LIMITS.maxScraperBytes} bytes`);

export const updateScraperArgsSchema = z.object({
  scraper_id: scraperIdSchema,
  updates: z.object(scraperFieldsShape).strict()
    .refine((updates) => Object.keys(updates).length > 0, 'updates must change at least one field'),
}).strict();

// ── App-review connectors (and web-review targets, which are stored the same way) ──

const APP_CONNECTOR_SOURCES = ['app_reviews_ios', 'app_reviews_android', 'web_reviews'] as const;
export type AppConnectorSource = (typeof APP_CONNECTOR_SOURCES)[number];
/** The `sort_by` options of each manifest. */
const IOS_SORT_ORDERS = ['most_recent'] as const;
const ANDROID_SORT_ORDERS = ['newest', 'rating'] as const;
/** The `frequency_minutes` options of the three manifests (0 = manual only). */
export const APP_FREQUENCY_MINUTES = [0, 15, 30, 60, 180, 360, 720, 1440] as const;
export const APP_CONNECTOR_LIMITS = { maxAppName: 100, maxPackageName: 255, maxReviewsPerRun: 5000, maxAppIdLength: 15 } as const;
/** What the SPA saves for an omitted field (the manifests' review cap; manual runs only). */
export const APP_CONNECTOR_DEFAULTS = { maxReviewsPerRun: 500, frequencyMinutes: 0 } as const;
/** web_reviews `max_pages` (lambda/shared/web_review_targets.py MIN_PAGES / MAX_PAGES / DEFAULT_PAGES); 0 = all pages. */
export const WEB_REVIEW_PAGES = { min: 0, max: 100, default: 10 } as const;
/** web_reviews `max_reviews` (lambda/shared/web_review_targets.py MIN_REVIEWS / MAX_REVIEWS / DEFAULT_REVIEWS); 0 = no limit. */
export const WEB_REVIEW_REVIEWS = { min: 0, max: 5000, default: 0 } as const;

/** The field each source names its target by, and the fields only that source takes. */
export const APP_ID_FIELD = { app_reviews_ios: 'app_id', app_reviews_android: 'package_name', web_reviews: 'url' } as const;
const SOURCE_FIELDS = {
  app_reviews_ios: ['app_id', 'sort_by', 'max_reviews_per_run'],
  app_reviews_android: ['package_name', 'sort_by', 'max_reviews_per_run'],
  web_reviews: ['url', 'max_pages', 'max_reviews'],
} as const satisfies Record<AppConnectorSource, readonly string[]>;
const SORT_ORDERS: Readonly<Record<AppConnectorSource, readonly string[]>> = {
  app_reviews_ios: IOS_SORT_ORDERS, app_reviews_android: ANDROID_SORT_ORDERS, web_reviews: [],
};
const SOURCE_SPECIFIC_FIELDS = [...new Set(Object.values(SOURCE_FIELDS).flat())];

const APP_NAME_PATTERN = /^[A-Za-z0-9][\w .-]*$/;
const PACKAGE_SEGMENT = /^[A-Za-z]\w*$/;

/** `com.example.app`: two or more dot-separated segments, each starting with a letter. */
export function isPackageName(value: string): boolean {
  const segments = value.split('.');
  return segments.length >= 2 && segments.every((segment) => PACKAGE_SEGMENT.test(segment));
}

export const createAppConnectorArgsSchema = z.object({
  source: z.enum(APP_CONNECTOR_SOURCES),
  app_name: z.string().trim().min(1).max(APP_CONNECTOR_LIMITS.maxAppName).regex(APP_NAME_PATTERN, 'letters, digits, spaces, ".", "_" or "-"'),
  app_id: z.string().trim().min(1).max(APP_CONNECTOR_LIMITS.maxAppIdLength).regex(DIGITS, 'the numeric App Store id').optional(),
  package_name: z.string().trim().max(APP_CONNECTOR_LIMITS.maxPackageName).refine(isPackageName, 'a package name like com.example.app').optional(),
  url: publicUrlSchema.optional(),
  sort_by: z.enum([...IOS_SORT_ORDERS, ...ANDROID_SORT_ORDERS]).optional(),
  max_reviews_per_run: z.number().int().min(1).max(APP_CONNECTOR_LIMITS.maxReviewsPerRun).optional(),
  max_pages: z.number().int().min(WEB_REVIEW_PAGES.min).max(WEB_REVIEW_PAGES.max).optional(),
  max_reviews: z.number().int().min(WEB_REVIEW_REVIEWS.min).max(WEB_REVIEW_REVIEWS.max).optional(),
  frequency_minutes: z.union(APP_FREQUENCY_MINUTES.map((minutes) => z.literal(minutes))).optional(),
  radar_brand: radarBrandKeySchema.optional(),
}).strict().superRefine((args, ctx) => {
  const identifier = APP_ID_FIELD[args.source];
  const own: readonly string[] = SOURCE_FIELDS[args.source];
  if (args[identifier] === undefined) ctx.addIssue({ code: 'custom', path: [identifier], message: `${args.source} needs ${identifier}` });
  for (const field of SOURCE_SPECIFIC_FIELDS.filter((name) => !own.includes(name) && args[name] !== undefined)) {
    ctx.addIssue({ code: 'custom', path: [field], message: `${args.source} does not take ${field}` });
  }
  const sortOrders = SORT_ORDERS[args.source];
  if (args.sort_by !== undefined && sortOrders.length > 0 && !sortOrders.includes(args.sort_by)) {
    ctx.addIssue({ code: 'custom', path: ['sort_by'], message: `one of ${sortOrders.join(', ')}` });
  }
});

// ── Source runs (run_source / get_source_run) ───────────────────────────────

/**
 * Plugins whose ingestor `POST /sources/{source}/run` starts by hand: every
 * plugin with an `ingestor/handler.py` except `webscraper`, whose runs are per
 * scraper (`run_scraper`). Pinned against `plugins/*` by server/source-tools.test.ts.
 */
export const RUN_SOURCE_IDS = ['app_reviews_ios', 'app_reviews_android', 'github_issues', 's3_import', 'synthetic_reviews', 'web_reviews'] as const;

/**
 * Plugins with an EventBridge schedule that `PUT /sources/{source}/enable|disable`
 * turns on or off (`set_source_enabled`): the manifests whose
 * `infrastructure.ingestor.schedule` is set. `s3_import` (S3-triggered) and
 * `synthetic_reviews` (manual only) have no rule to toggle. Pinned against
 * `plugins/*` by server/source-tools.test.ts. The route also refuses a plugin
 * this deployment did not enable.
 */
export const SCHEDULED_SOURCE_IDS = ['app_reviews_ios', 'app_reviews_android', 'github_issues', 'web_reviews', 'webscraper'] as const;
