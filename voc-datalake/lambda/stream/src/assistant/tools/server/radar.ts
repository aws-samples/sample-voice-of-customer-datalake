/**
 * `get_radar` (core pack, read-only): other brands tracked by Radar
 * (docs/radar.md), read from the Radar API as the caller. Radar reviews live in
 * their own table, so the feedback search tools never return them; this tool
 * is the only way the assistant sees them, and only when asked about another
 * brand, how we compare, or for ideas from the competition.
 *
 * Views: the tracked brands (no brand), `brands` (the brand list with its origin
 * and sources), and per brand `overview` (the default: summary + newest releases
 * + compare in one call), `summary`, `releases`, `compare`, `reviews` (filtered
 * and paged like GET /radar/brands/{brand}/reviews) and `review` (one review).
 * Results are shaped by radar-shape.ts (titled https links, small samples).
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import type { ApiCall } from '../internal-api.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult } from '../format.js';
import { idSchema, parseToolInput, toolSpec } from '../spec.js';
import { seg, serverTool } from './common.js';
import { labelResult } from './category-labels.js';
import { shapeBrands, shapeCompare, shapeReleases, shapeReviews } from './radar-shape.js';

const RADAR_VIEWS = ['overview', 'summary', 'releases', 'compare', 'reviews', 'review', 'brands'] as const;
/** What the overview reads, in one tool call (the live run called get_radar four times for one question). */
const OVERVIEW_PARTS = ['summary', 'releases', 'compare'] as const;
/** The overview keeps the newest releases; view releases has the rest. */
const OVERVIEW_RELEASES = 12;
type RadarView = (typeof RADAR_VIEWS)[number];
/** The Radar API's widest window (radar_handler.MAX_DAYS). */
const MAX_RADAR_DAYS = 365;
/** radar_reviews: a page holds at most 50 reviews. */
const MAX_REVIEWS_LIMIT = 50;
/** Brand keys are slugs (shared/radar_brands.brand_key). */
const BRAND_KEY_PATTERN = /^[\w-]{1,64}$/u;
const RADAR_SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
const MAX_FILTER_CHARS = 100;
const MAX_CURSOR_CHARS = 2000;
const RADAR_RESULT_BUDGET = 24_000;
/** Fields only the `reviews` view takes (the REST route's query filters). */
const REVIEW_FILTERS = ['category', 'subcategory', 'sentiment', 'day', 'cursor', 'limit'] as const;

const radarInput = z.object({
  brand: z.string().trim().regex(BRAND_KEY_PATTERN, 'must be a brand key from get_radar view "brands"').optional(),
  view: z.enum(RADAR_VIEWS).optional(),
  days: z.number().int().min(1).max(MAX_RADAR_DAYS).optional(),
  category: z.string().trim().min(1).max(MAX_FILTER_CHARS).optional(),
  subcategory: z.string().trim().max(MAX_FILTER_CHARS).optional(),
  sentiment: z.enum(RADAR_SENTIMENTS).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date').optional(),
  cursor: z.string().min(1).max(MAX_CURSOR_CHARS).optional(),
  limit: z.number().int().min(1).max(MAX_REVIEWS_LIMIT).optional(),
  feedback_id: idSchema.optional(),
}).strict().superRefine((args, ctx) => {
  const view = defaultView(args);
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (view !== 'brands' && view !== 'summary' && view !== 'overview' && args.brand === undefined) issue('brand', `view ${view} needs a brand`);
  if (view === 'review' && args.feedback_id === undefined) issue('feedback_id', 'view review needs a feedback_id');
  if (view !== 'review' && args.feedback_id !== undefined) issue('feedback_id', 'only view review takes a feedback_id');
  for (const field of REVIEW_FILTERS.filter((name) => view !== 'reviews' && args[name] !== undefined)) {
    issue(field, `only view reviews takes ${field}`);
  }
});
type RadarInput = z.infer<typeof radarInput>;

/** A route under `/radar/{proxy+}` (every Radar route but the overview). */
function radarProxyCall(proxy: string, query?: ApiCall['query']): ApiCall {
  const path = `/radar/${proxy.split('/').map(seg).join('/')}`;
  return { fn: 'radar', method: 'GET', path, resource: '/radar/{proxy+}', pathParameters: { proxy }, ...(query === undefined ? {} : { query }) };
}

/** The path suffix of each brand view read whole (`summary` is the brand itself); literal, so a route audit can see the callers. */
const BRAND_VIEW_SUFFIX = { summary: '', releases: '/releases', compare: '/compare' } as const;

/** The route of one brand's view. */
function brandCall(brand: string, view: RadarView, input: RadarInput): ApiCall {
  const days = input.days === undefined ? {} : { days: input.days };
  if (view === 'review') return radarProxyCall(`brands/${brand}/reviews/${input.feedback_id ?? ''}`);
  if (view === 'reviews') {
    const filters = Object.fromEntries(REVIEW_FILTERS.flatMap((name) => (input[name] === undefined ? [] : [[name, input[name]]])));
    return radarProxyCall(`brands/${brand}/reviews`, { ...days, ...filters });
  }
  const suffix = view === 'releases' || view === 'compare' ? BRAND_VIEW_SUFFIX[view] : BRAND_VIEW_SUFFIX.summary;
  return radarProxyCall(`brands/${brand}${suffix}`, input.days === undefined ? undefined : days);
}

function radarCall(input: RadarInput): ApiCall {
  const view = defaultView(input);
  if (view === 'brands') return radarProxyCall('brands');
  if (input.brand === undefined) return { fn: 'radar', method: 'GET', path: '/radar', resource: '/radar' };
  return brandCall(input.brand, view, input);
}

/** With a brand and no view: everything for the window in one call. */
function defaultView(input: RadarInput): RadarView {
  return input.view ?? (input.brand === undefined ? 'summary' : 'overview');
}

/** One view's body shaped for the model (radar-shape.ts). */
function shapeView(view: RadarView, body: unknown, nowMs: number): unknown {
  if (view === 'releases') return shapeReleases(body, nowMs);
  if (view === 'compare') return shapeCompare(body);
  if (view === 'reviews' || view === 'review') return shapeReviews(body);
  // Both the brand list and the tracked brands (no brand: view summary over GET /radar) carry `sources`.
  if (view === 'brands' || view === 'summary') return shapeBrands(body);
  return body;
}

/** The overview: summary, releases (newest OVERVIEW_RELEASES) and compare, read in parallel. */
async function overview(deps: ToolDeps, ctx: AssistantRunContext, brand: string, input: RadarInput): Promise<unknown> {
  const [summary, releases, compare] = await Promise.all(
    OVERVIEW_PARTS.map((view) => deps.invoke(brandCall(brand, view, input), ctx.claims)),
  );
  const shaped = shapeReleases(releases, deps.nowMs());
  const list = isRecord(shaped) && Array.isArray(shaped.releases) ? shaped.releases.slice(0, OVERVIEW_RELEASES) : [];
  return {
    summary,
    releases: { ...(isRecord(shaped) ? shaped : {}), releases: list },
    compare: shapeCompare(compare),
    note: 'This is everything Radar holds for the brand in these windows; call another view only to drill down '
      + '(reviews, one review, older releases).',
  };
}

async function readRadar(deps: ToolDeps, ctx: AssistantRunContext, input: RadarInput): Promise<unknown> {
  const view = defaultView(input);
  if (view === 'overview' && input.brand !== undefined) return overview(deps, ctx, input.brand, input);
  return shapeView(view, await deps.invoke(radarCall(input), ctx.claims), deps.nowMs());
}

function getRadarTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('get_radar', 'core', toolSpec(
    'get_radar',
    'Radar: OTHER brands (competitors, partners) tracked by Radar — never our own feedback. Without `brand`: the tracked '
      + 'brands with their review totals and average sentiment. view "brands": the brand list (key, label, domains, '
      + 'language, effective_language, feed_urls, search_terms, exclude_terms, origin list|profile, profile_sources = older source profiles only, never connectors). With `brand` (a key from those) and no `view`: the overview — summary, the newest '
      + 'releases and compare in ONE call; it is everything Radar holds for the window, so call it once and use another '
      + 'view only to drill down. `view` summary = sentiment trend plus what their '
      + 'customers love and hate (themes, counts, redacted quotes); releases = releases and news (kind: release, '
      + 'announcement, promotion, partnership, news; found_via: web, exa, feed), with '
      + 'ready-made markdown `links` (cite those links as they are, never a bare URL); compare = per category, their sentiment and volume against ours; reviews = '
      + 'the reviews themselves, newest first, filtered by category, subcategory ("" = none), sentiment, day (YYYY-MM-DD), '
      + 'paged with limit (≤ 50) and the next_cursor of the previous page as cursor; review = one review in full '
      + '(feedback_id from reviews). To pull ideas from a brand: compare (where they beat us), then reviews with '
      + 'sentiment positive in those categories (what their customers love) and negative (gaps to avoid). Use it only '
      + 'when the user asks about another brand, how we compare, or for ideas from them.',
    {
      brand: { type: 'string', maxLength: 64, description: 'Brand key from view "brands" (or get_radar without a brand).' },
      view: { type: 'string', enum: [...RADAR_VIEWS], description: 'overview (default with a brand), summary, releases, compare, reviews, review or brands.' },
      days: { type: 'integer', minimum: 1, maximum: MAX_RADAR_DAYS, description: 'Window in days (default 90; releases 365).' },
      category: { type: 'string', maxLength: MAX_FILTER_CHARS, description: 'reviews: one category.' },
      subcategory: { type: 'string', maxLength: MAX_FILTER_CHARS, description: 'reviews: one subcategory; "" = reviews without one.' },
      sentiment: { type: 'string', enum: [...RADAR_SENTIMENTS], description: 'reviews: one sentiment.' },
      day: { type: 'string', description: 'reviews: one day (YYYY-MM-DD) inside the window.' },
      cursor: { type: 'string', maxLength: MAX_CURSOR_CHARS, description: 'reviews: next_cursor of the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_REVIEWS_LIMIT, description: 'reviews: page size (default 25).' },
      feedback_id: { type: 'string', maxLength: 128, description: 'review: the review\u2019s feedback_id.' },
    },
  ), async (input, ctx) => {
    const body = await readRadar(deps, ctx, parseToolInput(radarInput, input));
    return { content: jsonResult(await labelResult(deps, ctx, body), RADAR_RESULT_BUDGET) };
  });
}

export function createRadarServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [getRadarTool(deps)];
}
