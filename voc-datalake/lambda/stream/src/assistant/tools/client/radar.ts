/**
 * Radar write tools of the `scrapers` pack (admin-only, docs/radar.md), and the
 * brand precheck the connector tools share:
 *
 *   - `save_radar_brands`: the WHOLE brand list (PUT /radar/brands). The SPA
 *     card diffs it against the stored list and the executor refuses when that
 *     list changed before approval.
 *   - `run_radar_scan`: POST /radar/scan, every brand or one.
 *
 * Both are CARD_ONLY_WRITE_TOOLS (plan/schema.ts): the plan-step runner may not
 * invoke the Radar API, so a plan never names them; "set up Radar for X" runs as
 * approval cards in the chat.
 *
 * Every Radar read here is GET /radar/brands as the caller, so a brand the user
 * may not see reads as absent.
 */
import type { AssistantRunContext, ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { recordsAt } from '../server/feedback-shape.js';
import { defineClientTool } from './define.js';
import { RADAR_BRAND_LANGUAGES, RADAR_BRAND_LIMITS, radarBrandKey, runRadarScanArgsSchema, saveRadarBrandsArgsSchema } from './radar-schemas.js';

/** The tracked brands' keys (list + legacy source-profile brands), as the caller sees them. */
async function radarBrandKeys(deps: ToolDeps, ctx: AssistantRunContext): Promise<Set<string>> {
  const body = await deps.invoke({
    fn: 'radar', method: 'GET', path: '/radar/brands', resource: '/radar/{proxy+}', pathParameters: { proxy: 'brands' },
  }, ctx.claims);
  return new Set(recordsAt(body, 'brands').flatMap((brand) => (typeof brand.key === 'string' ? [brand.key] : [])));
}

const unknownBrand = (key: string) => `no Radar brand has key "${key}". Read get_radar view "brands"; to track a new brand, `
  + 'propose save_radar_brands first and use the key its result returns.';

/** Why `key` cannot be a connector's `radar_brand` (no such brand), else undefined. Absent / '' = an ordinary source. */
export async function radarBrandProblem(deps: ToolDeps, ctx: AssistantRunContext, key: string | undefined): Promise<string | undefined> {
  if (key === undefined || key === '') return undefined;
  return (await radarBrandKeys(deps, ctx)).has(key) ? undefined : unknownBrand(key);
}

function saveRadarBrands(): ClientToolDefinition {
  return defineClientTool({
    name: 'save_radar_brands',
    pack: 'scrapers',
    description: 'Replace the Radar brand list (admin): the OTHER brands (competitors, partners) Radar tracks — it web-searches '
      + 'their news and releases, and the scrapers / connectors marked with their key bring their reviews to Radar only. '
      + 'Send the COMPLETE list: read get_radar view "brands" first and keep every brand with origin "list" the user did not '
      + 'ask to remove (origin "profile" brands come from source profiles and stay without being listed). Each brand: '
      + `label (1-${RADAR_BRAND_LIMITS.maxLabelChars} characters) and domains (up to ${RADAR_BRAND_LIMITS.maxDomains} of its own `
      + 'sites, e.g. example-air.example, which the news scan searches), language (optional, a two-letter code such as pl or cs; '
      + `omit for auto = from the first domain), feed_urls (optional, up to ${RADAR_BRAND_LIMITS.maxFeedUrls} https RSS / Atom `
      + 'feed URLs of its news), search_terms (optional, up to '
      + `${RADAR_BRAND_LIMITS.maxTerms} words or phrases of ${RADAR_BRAND_LIMITS.maxTermChars} characters at most, such as its legal name `
      + 'or product names, added to its news searches: use them when the brand name is also a common word) and exclude_terms '
      + '(optional, same bounds: a search result whose title or snippet contains one is dropped). Keep the language, feed_urls, '
      + 'search_terms and exclude_terms a listed brand already has. Its key is the label lower-cased with every run of other '
      + 'characters as "-" ("Acme Air" → acme-air). Removing a brand stops its scans and its review routing; stored reviews '
      + 'and releases are kept. To set up Radar for a brand: this, then create_scraper or create_app_connector with '
      + 'radar_brand = its key, then run it (run_scraper / run_source), then run_radar_scan {brand}.',
    properties: {
      brands: {
        type: 'array',
        maxItems: RADAR_BRAND_LIMITS.maxBrands,
        description: 'The whole list.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: RADAR_BRAND_LIMITS.maxLabelChars, description: 'Brand name as shown.' },
            domains: { type: 'array', items: { type: 'string' }, maxItems: RADAR_BRAND_LIMITS.maxDomains, description: 'Its own domains.' },
            language: { type: 'string', enum: [...RADAR_BRAND_LANGUAGES], description: 'The language it publishes in; omit for auto.' },
            feed_urls: {
              type: 'array', items: { type: 'string', maxLength: RADAR_BRAND_LIMITS.maxFeedUrlChars },
              maxItems: RADAR_BRAND_LIMITS.maxFeedUrls, description: 'https RSS / Atom feeds of its news.',
            },
            search_terms: termsProperty('Words or phrases added to its news searches (legal name, product names).'),
            exclude_terms: termsProperty('Words or phrases that drop a search result containing them.'),
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    required: ['brands'],
    schema: saveRadarBrandsArgsSchema,
    summarize: (args) => (args.brands.length === 0
      ? 'Clear the Radar brand list.'
      : `Save the Radar brand list: ${args.brands.map((brand) => brandWithKey(brand.label)).join(', ')}.`),
  });
}

/** The JSON schema of a search_terms / exclude_terms list. */
function termsProperty(description: string) {
  return {
    type: 'array', items: { type: 'string', maxLength: RADAR_BRAND_LIMITS.maxTermChars },
    maxItems: RADAR_BRAND_LIMITS.maxTerms, description,
  };
}

/** "Acme Air (acme-air)" in a summary. */
function brandWithKey(label: string): string {
  return `${label} (${radarBrandKey(label)})`;
}

function runRadarScan(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'run_radar_scan',
    pack: 'scrapers',
    description: 'Start the Radar news scan now (admin), ignoring the cadence: it files each brand\u2019s news (releases, '
      + 'announcements, promotions, partnerships, company news) from web search, Exa and its feeds (every tracked brand without `brand`). Use it when the '
      + 'user asks to scan, refresh or look for a brand\u2019s news, releases, launches or announcements. It runs in the '
      + 'background for a few minutes and spends web searches; afterwards get_radar view "releases" lists what it found.',
    properties: { brand: { type: 'string', maxLength: RADAR_BRAND_LIMITS.maxLabelChars, description: 'Brand key (get_radar view "brands"); omit for every brand.' } },
    required: [],
    schema: runRadarScanArgsSchema,
    precheck: async (args, ctx) => {
      const keys = await radarBrandKeys(deps, ctx);
      if (keys.size === 0) return 'no Radar brand is tracked yet. Propose save_radar_brands first.';
      return args.brand === undefined || keys.has(args.brand) ? undefined : unknownBrand(args.brand);
    },
    summarize: (args) => (args.brand === undefined ? 'Scan every Radar brand for news now.' : `Scan Radar brand ${args.brand} for news now.`),
  });
}

export function createRadarClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [saveRadarBrands(), runRadarScan(deps)];
}
