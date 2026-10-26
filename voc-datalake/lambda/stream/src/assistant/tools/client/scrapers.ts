/**
 * Connector write tools of the `scrapers` pack (admin-only): create / update a
 * web scraper and add an app-review connector. The model proposes; the SPA
 * shows a deterministic approval card and, on approval, executes through the
 * admin-only REST routes with the user's own token.
 *
 * `create_scraper` and `update_scraper` read GET /scrapers (as the caller)
 * before the card is raised: a create whose id already exists, or an update of
 * an id that does not, is refused here. The SPA re-checks right before it
 * executes — a create never overwrites, an update refuses a changed scraper.
 */
import type { AssistantRunContext, ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { recordsAt } from '../server/feedback-shape.js';
import {
  APP_CONNECTOR_DEFAULTS,
  APP_CONNECTOR_LIMITS,
  APP_FREQUENCY_MINUTES,
  MAX_SCRAPER_ID_LENGTH,
  SCRAPER_LIMITS,
  WEB_REVIEW_PAGES,
  WEB_REVIEW_REVIEWS,
  createAppConnectorArgsSchema,
  createScraperArgsSchema,
  updateScraperArgsSchema,
} from './scraper-schemas.js';
import { MAX_LABEL_TAGS } from './allowlists.js';
import { radarBrandProblem } from './radar.js';
import { defineClientTool, q, stringProperty } from './define.js';
import type { JsonSchemaProperties } from '../spec.js';

const urlProperty = (description: string) => ({ type: 'string', maxLength: SCRAPER_LIMITS.maxUrlLength, description });
const selector = (description: string) => stringProperty(description, SCRAPER_LIMITS.maxTextField);

/** Marks a Radar source (docs/radar.md): the reviews it brings in go to that other brand's Radar, never to our feedback. */
const RADAR_BRAND_PROPERTY = stringProperty(
  'Radar source: the key of a tracked OTHER brand (get_radar view "brands"; add one with save_radar_brands first). '
    + 'Omit for our own reviews. In update_scraper, "" turns it back into an ordinary source.',
  MAX_SCRAPER_ID_LENGTH,
);

/** The model-facing properties shared by create and update (update has them under `updates`). */
const SCRAPER_PROPERTIES: JsonSchemaProperties = {
  name: stringProperty('Display name.', SCRAPER_LIMITS.maxTextField),
  base_url: urlProperty('Main page to scrape (public https URL). Pagination appends its parameter to it.'),
  urls: { type: 'array', items: urlProperty('Extra page (public https URL).'), maxItems: SCRAPER_LIMITS.maxUrls, description: 'Additional pages to scrape.' },
  extraction_method: { type: 'string', enum: ['jsonld', 'css'], description: 'jsonld = schema.org Review data on the page; css = CSS selectors.' },
  container_selector: selector('css: selector of one review block (required for css).'),
  text_selector: selector('css: selector of the review text inside a block (required for css).'),
  title_selector: selector('css: review title selector.'),
  rating_selector: selector('css: rating selector.'),
  rating_attribute: selector('css: attribute holding the rating value.'),
  date_selector: selector('css: date selector.'),
  author_selector: selector('css: author selector.'),
  link_selector: selector('css: per-review link selector.'),
  pagination: {
    type: 'object',
    description: `{enabled, param?, max_pages? 1-${SCRAPER_LIMITS.maxPages}, start? 0-${SCRAPER_LIMITS.maxPaginationStart}}.`,
  },
  frequency_minutes: {
    type: 'integer', minimum: 0, maximum: SCRAPER_LIMITS.maxFrequencyMinutes,
    description: 'Minutes between scheduled runs; 0 = manual runs only.',
  },
  enabled: { type: 'boolean', description: 'Whether the schedule runs. Leave false unless the user asked to schedule it.' },
  dimension_defaults: { type: 'object', description: 'Dimension values stamped on every review found ({key: value}, from list_dimensions).' },
  tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_LABEL_TAGS, description: 'Tags stamped on every review found.' },
  radar_brand: RADAR_BRAND_PROPERTY,
};

/** " for Radar brand <key>" in a one-line summary, '' for an ordinary source. */
function radarSuffix(key: string | undefined): string {
  return key === undefined || key === '' ? '' : ` for Radar brand ${key}`;
}

/** The ids of GET /scrapers, as the caller. */
async function scraperIds(deps: ToolDeps, ctx: AssistantRunContext): Promise<Set<string>> {
  const body = await deps.invoke({ fn: 'scrapers', method: 'GET', path: '/scrapers', resource: '/scrapers' }, ctx.claims);
  return new Set(recordsAt(body, 'scrapers').flatMap((s) => (typeof s.id === 'string' ? [s.id] : [])));
}

function createScraper(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'create_scraper',
    pack: 'scrapers',
    description: 'Create a NEW web scraper (admin). Call list_scrapers first and pick an id no scraper uses — a create '
      + 'never overwrites. For css, analyze_scraper_url can suggest selectors. It is saved disabled with no schedule '
      + 'unless the user asked for one; running it is a separate run_scraper step.',
    properties: { id: stringProperty('New scraper id: 1-64 letters, digits, "_" or "-".', MAX_SCRAPER_ID_LENGTH), ...SCRAPER_PROPERTIES },
    required: ['id', 'name', 'extraction_method'],
    schema: createScraperArgsSchema,
    precheck: async (args, ctx) => ((await scraperIds(deps, ctx)).has(args.id)
      ? `a scraper with id "${args.id}" already exists. Pick another id, or propose update_scraper to change it.`
      : radarBrandProblem(deps, ctx, args.radar_brand)),
    summarize: (args) => `Create web scraper ${q(args.name)} (${args.id})${radarSuffix(args.radar_brand)}.`,
  });
}

function updateScraper(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'update_scraper',
    pack: 'scrapers',
    description: 'Change fields of an EXISTING web scraper (admin). `updates` holds only the fields to change; the '
      + 'user sees a before → after diff against the stored scraper. Read list_scrapers first.',
    properties: {
      scraper_id: stringProperty('Scraper id from list_scrapers.', MAX_SCRAPER_ID_LENGTH),
      updates: { type: 'object', description: 'Fields to change.', properties: SCRAPER_PROPERTIES, additionalProperties: false },
    },
    required: ['scraper_id', 'updates'],
    schema: updateScraperArgsSchema,
    precheck: async (args, ctx) => ((await scraperIds(deps, ctx)).has(args.scraper_id)
      ? radarBrandProblem(deps, ctx, args.updates.radar_brand)
      : `no scraper has id "${args.scraper_id}". Read list_scrapers; to add one, propose create_scraper.`),
    summarize: (args) => `Update web scraper ${args.scraper_id}: ${Object.keys(args.updates).join(', ')}.`,
  });
}

const CONNECTOR_LABEL = { app_reviews_ios: 'iOS app', app_reviews_android: 'Android app', web_reviews: 'web reviews' } as const;

const createAppConnector = (deps: ToolDeps) => defineClientTool({
  name: 'create_app_connector',
  pack: 'scrapers',
  description: 'Add a review connector (admin): app_reviews_ios takes app_id (the numeric App Store id), '
    + 'app_reviews_android takes package_name (e.g. com.example.app), web_reviews takes url (a public https review '
    + 'page, e.g. a Trustpilot or TripAdvisor page, read with a managed browser), max_pages and max_reviews. Defaults: newest reviews first, '
    + `${APP_CONNECTOR_DEFAULTS.maxReviewsPerRun} reviews per run (apps) or the latest ${WEB_REVIEW_PAGES.default} pages per run with no review limit (web), `
    + 'manual runs only (frequency_minutes 0) unless the user asked for a schedule. A web_reviews connector\u2019s reviews '
    + 'import as their own source "web_<site>_<app_name>" (app_name "Example Air" on a www.trustpilot.com page is '
    + 'web_trustpilot_example_air), named once when it is created and kept if it is renamed. With radar_brand its reviews '
    + 'go to Radar (that other brand), never to our own feedback.',
  properties: {
    source: { type: 'string', enum: ['app_reviews_ios', 'app_reviews_android', 'web_reviews'], description: 'Which store, or web_reviews for a review web page.' },
    app_name: stringProperty('Short name (letters, digits, spaces, ".", "_", "-").', APP_CONNECTOR_LIMITS.maxAppName),
    app_id: stringProperty('iOS only: numeric App Store id.', APP_CONNECTOR_LIMITS.maxAppIdLength),
    package_name: stringProperty('Android only: package name.', APP_CONNECTOR_LIMITS.maxPackageName),
    url: urlProperty('web_reviews only: the review page (https).'),
    sort_by: { type: 'string', enum: ['most_recent', 'newest', 'rating'], description: 'iOS: most_recent. Android: newest or rating.' },
    max_reviews_per_run: { type: 'integer', minimum: 1, maximum: APP_CONNECTOR_LIMITS.maxReviewsPerRun, description: 'Apps only: cap per run.' },
    max_pages: {
      type: 'integer', minimum: WEB_REVIEW_PAGES.min, maximum: WEB_REVIEW_PAGES.max,
      description: `web_reviews only: latest N pages per run (default ${WEB_REVIEW_PAGES.default}; 0 = all pages).`,
    },
    max_reviews: {
      type: 'integer', minimum: WEB_REVIEW_REVIEWS.min, maximum: WEB_REVIEW_REVIEWS.max,
      description: `web_reviews only: stop after N reviews (default ${WEB_REVIEW_REVIEWS.default} = no limit). `
        + "Use max_pages 0 + max_reviews N for 'latest N reviews', both 0 for everything.",
    },
    frequency_minutes: { type: 'integer', enum: [...APP_FREQUENCY_MINUTES], description: 'Minutes between runs; 0 = manual only.' },
    radar_brand: RADAR_BRAND_PROPERTY,
  },
  required: ['source', 'app_name'],
  schema: createAppConnectorArgsSchema,
  precheck: (args, ctx) => radarBrandProblem(deps, ctx, args.radar_brand),
  summarize: (args) => {
    const identifier = args.app_id ?? args.package_name ?? args.url ?? '';
    return `Add ${CONNECTOR_LABEL[args.source]} connector ${q(args.app_name)} (${identifier})${radarSuffix(args.radar_brand)}.`;
  },
});


export function createScraperClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [createScraper(deps), updateScraper(deps), createAppConnector(deps)];
}
