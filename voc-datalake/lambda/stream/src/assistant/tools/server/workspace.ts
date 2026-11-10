/**
 * Server tools for the `forms`, `prioritization`, `scrapers` and `settings`
 * packs — small read-only views of the corresponding admin/workspace pages.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ApiCall } from '../internal-api.js';
import type { ToolDeps } from '../deps.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult, pick } from '../format.js';
import { idProperty, idSchema, parseToolInput, toolSpec } from '../spec.js';
import { recordsAt, toFeedbackSources } from './feedback-shape.js';
import { getSettingsRoute, seg, serverTool } from './common.js';
import { AssistantToolError } from '../errors.js';
import { ApiError } from '../../../lib/errors.js';
import { SCRAPER_ANALYZE_RESOURCE } from '../internal-api.js';
import { SCRAPER_SELECTOR_FIELDS, publicUrlSchema } from '../client/scraper-schemas.js';
import { awaitAssistJob } from './assist-job.js';

const noInput = z.object({}).strict();
const formIdInput = z.object({ form_id: idSchema }).strict();
const submissionsInput = z.object({ form_id: idSchema, limit: z.number().int().min(1).max(50).optional() }).strict();
const scraperIdInput = z.object({ scraper_id: idSchema }).strict();

const FORM_FIELDS = [
  'form_id', 'name', 'enabled', 'title', 'description', 'question', 'placeholder', 'rating_enabled', 'rating_type',
  'rating_max', 'submit_button_text', 'success_message', 'collect_email', 'collect_name', 'category', 'subcategory',
  'project_id', 'document_id', 'created_at', 'updated_at',
] as const;

const SUBMISSION_FIELDS = [
  'feedback_id', 'original_text', 'rating', 'sentiment_label', 'sentiment_score', 'category', 'created_at', 'persona_name',
] as const;

/** Scraper configs are stored verbatim; only these keys reach the model (no headers or cookies). */
const SCRAPER_FIELDS = [
  'id', 'name', 'enabled', 'base_url', 'urls', 'frequency_minutes', 'extraction_method', 'template', 'last_run', 'items_found',
  // The Radar brand key a scraper feeds (docs/radar.md); absent = an ordinary source.
  'radar_brand',
] as const;
/**
 * Administrators (the only callers who may change a scraper) also see what an
 * update would edit: selectors, pagination and labels.
 */
const ADMIN_SCRAPER_FIELDS = [
  ...SCRAPER_FIELDS, ...SCRAPER_SELECTOR_FIELDS, 'pagination', 'dimension_defaults', 'tags',
] as const;
/** App-review connectors and review pages (GET /scrapers/connectors): what each is and the Radar brand it feeds. */
const CONNECTOR_FIELDS = [
  'source', 'id', 'app_name', 'app_id', 'package_name', 'url', 'enabled', 'frequency_minutes', 'source_id', 'radar_brand',
] as const;
/** The selector suggestion keys analyze-url answers with (its prompt's JSON). */
const SUGGESTION_FIELDS = [
  ...SCRAPER_SELECTOR_FIELDS, 'confidence', 'detected_reviews_count', 'notes', 'warnings',
] as const;
const analyzeInput = z.object({ url: publicUrlSchema }).strict();

type Invoke = (call: Omit<ApiCall, 'method'>, ctx: AssistantRunContext) => Promise<unknown>;

function getter(deps: ToolDeps): Invoke {
  return (call, ctx) => deps.invoke({ ...call, method: 'GET' }, ctx.claims);
}

function formsTools(get: Invoke): ServerToolDefinition[] {
  const list = serverTool('list_feedback_forms', 'forms', toolSpec(
    'list_feedback_forms',
    'All embeddable feedback forms with their settings (enabled, title, question, rating, linked project).',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const forms = recordsAt(await get({ fn: 'feedbackForms', path: '/feedback-forms', resource: '/feedback-forms' }, ctx), 'forms');
    return { content: jsonResult({ count: forms.length, forms: forms.map((form) => pick(form, FORM_FIELDS, 300)) }) };
  });

  const stats = serverTool('get_feedback_form_stats', 'forms', toolSpec(
    'get_feedback_form_stats',
    'Submission count, average rating and rating count of one feedback form.',
    { form_id: idProperty('Feedback form id.') },
    ['form_id'],
  ), async (input, ctx) => {
    const { form_id: formId } = parseToolInput(formIdInput, input);
    const body = await get({
      fn: 'feedbackForms',
      path: `/feedback-forms/${seg(formId)}/stats`,
      resource: '/feedback-forms/{form_id}/stats',
      pathParameters: { form_id: formId },
    }, ctx);
    return { content: jsonResult(isRecord(body) ? { form_id: formId, stats: body.stats } : body) };
  });

  const submissions = serverTool('get_feedback_form_submissions', 'forms', toolSpec(
    'get_feedback_form_submissions',
    'The newest submissions of one feedback form (text, rating, sentiment, category).',
    {
      form_id: idProperty('Feedback form id.'),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max submissions (default 20).' },
    },
    ['form_id'],
  ), async (input, ctx) => {
    const args = parseToolInput(submissionsInput, input);
    const body = await get({
      fn: 'feedbackForms',
      path: `/feedback-forms/${seg(args.form_id)}/submissions`,
      resource: '/feedback-forms/{form_id}/submissions',
      pathParameters: { form_id: args.form_id },
      query: { limit: args.limit ?? 20 },
    }, ctx);
    const rows = recordsAt(body, 'submissions');
    return {
      content: jsonResult({ form_id: args.form_id, returned: rows.length, submissions: rows.map((row) => pick(row, SUBMISSION_FIELDS, 500)) }),
      sources: toFeedbackSources(rows),
    };
  });
  return [list, stats, submissions];
}

/** English names of the four built-in metrics (a built-in's `label` is null unless an admin renamed it). */
const BUILTIN_METRIC_NAMES: Readonly<Record<string, string>> = {
  impact: 'Impact',
  time_to_market: 'Time to market',
  strategic_fit: 'Strategic fit',
  confidence: 'Confidence',
};

/**
 * The scoring setup in words the model can use: the ACTIVE metrics with a name, their
 * share of the composite (%) and direction. Archived metrics are left out — they are
 * neither shown nor scored. Read off the GET's `axes`, never a fixed list.
 */
function scoringMetrics(axes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(axes)) return [];
  const weightOf = (axis: Record<string, unknown>): number => (typeof axis.weight === 'number' ? axis.weight : 0);
  const active = axes.filter((axis): axis is Record<string, unknown> => isRecord(axis) && axis.archived !== true);
  const total = active.reduce((sum, axis) => sum + weightOf(axis), 0);
  return active.map((axis) => {
    const id = typeof axis.id === 'string' ? axis.id : '';
    return {
      id,
      name: typeof axis.label === 'string' && axis.label ? axis.label : (BUILTIN_METRIC_NAMES[id] ?? id),
      share_percent: total > 0 ? Math.round((weightOf(axis) / total) * 100) : 0,
      direction: axis.direction === 'lower_better' ? 'lower is better' : 'higher is better',
    };
  });
}

function prioritizationTools(get: Invoke): ServerToolDefinition[] {
  return [serverTool('get_prioritization', 'prioritization', toolSpec(
    'get_prioritization',
    'The prioritization board: the workspace\u2019s scoring metrics (scoring_metrics: name, share of the composite, '
      + 'direction; each scored 1\u20135, 0 = not scored), each row (a project\u2019s set of documents), the signed-in '
      + 'user\u2019s own scores per metric id and the team aggregate (mean per metric id, composite on the 1\u20135 '
      + 'scale, reviewer count, spread). Use list_projects to name the projects.',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const body = await get({ fn: 'projects', path: '/projects/prioritization', resource: '/projects/prioritization' }, ctx);
    return { content: jsonResult(isRecord(body) ? { scoring_metrics: scoringMetrics(body.axes), ...body } : body) };
  })];
}

/** GET /scrapers/jobs/{job_id} as the caller (the scrapers `{proxy+}` resource). */
function readScraperJob(deps: ToolDeps, ctx: AssistantRunContext, jobId: string): Promise<unknown> {
  return deps.invoke({
    fn: 'scrapers',
    method: 'GET',
    path: `/scrapers/jobs/${seg(jobId)}`,
    resource: '/scrapers/{proxy+}',
    pathParameters: { proxy: `jobs/${jobId}` },
  }, ctx.claims);
}

/**
 * analyze_scraper_url: the admin-only analyze route as the caller. The route
 * starts an assist job (202 `{job_id}`); the tool polls GET /scrapers/jobs/{id}
 * inside the run until the suggestion is ready. The result is a suggestion for
 * the model only; no scraper is saved and no card is raised.
 */
function analyzeTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('analyze_scraper_url', 'scrapers', toolSpec(
    'analyze_scraper_url',
    'Administrators: fetch a public https page and suggest CSS selectors for its reviews (container, text, rating, '
      + 'author, date) with a confidence. Saves nothing — use the suggestion in a create_scraper / update_scraper '
      + 'proposal the user approves. Can take a minute or more.',
    { url: { type: 'string', maxLength: 2048, description: 'Public https URL of a page with reviews.' } },
    ['url'],
  ), async (input, ctx) => {
    if (!ctx.isAdmin) throw new AssistantToolError('not_permitted', 'analyze_scraper_url is only available to administrators.');
    const { url } = parseToolInput(analyzeInput, input);
    const started = await deps.invoke({
      fn: 'scrapers', method: 'POST', path: SCRAPER_ANALYZE_RESOURCE, resource: SCRAPER_ANALYZE_RESOURCE, body: { url },
    }, ctx.claims);
    const body = await awaitAssistJob(deps, {
      started,
      poll: (jobId) => readScraperJob(deps, ctx, jobId),
      ...(ctx.deadlineMs === undefined ? {} : { deadlineMs: ctx.deadlineMs }),
      label: 'The page analysis',
    });
    const selectors = isRecord(body) && isRecord(body.selectors) ? pick(body.selectors, SUGGESTION_FIELDS, 300) : {};
    return { content: jsonResult({ url, saved: false, selectors }) };
  });
}

/**
 * The app connectors and review pages (GET /scrapers/connectors, the scrapers API: the stream may not invoke the
 * integrations API). A failed read says so instead of failing the scraper list.
 */
async function readConnectors(get: Invoke, ctx: AssistantRunContext): Promise<Record<string, unknown>> {
  try {
    const body = await get({
      fn: 'scrapers', path: '/scrapers/connectors', resource: '/scrapers/{proxy+}', pathParameters: { proxy: 'connectors' },
    }, ctx);
    const connectors = recordsAt(body, 'connectors');
    return { connector_count: connectors.length, connectors: connectors.map((c) => pick(c, CONNECTOR_FIELDS, 300)) };
  } catch (error) {
    // Any API failure (a 4xx/5xx answer, an invoke error); a programming error still throws.
    if (!(error instanceof ApiError)) throw error;
    return { connectors: [], connectors_note: 'The app connectors could not be read just now; the scrapers above are complete.' };
  }
}

function scrapersTools(get: Invoke, deps: ToolDeps): ServerToolDefinition[] {
  const list = serverTool('list_scrapers', 'scrapers', toolSpec(
    'list_scrapers',
    'Configured web scrapers (id, name, enabled, target URLs, schedule, last run, radar_brand = the Radar brand it '
      + 'feeds; for administrators also selectors, pagination and labels), and `connectors`: the app-review connectors '
      + 'and review pages (source app_reviews_ios | app_reviews_android | web_reviews, id, app_name, app_id / '
      + 'package_name / url, enabled, frequency_minutes, source_id, radar_brand = the Radar brand it feeds; none = our '
      + 'own feedback). Read it before proposing create_scraper, update_scraper or create_app_connector, and to see '
      + 'which sources feed a Radar brand.',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const [scraperBody, connectors] = await Promise.all([
      get({ fn: 'scrapers', path: '/scrapers', resource: '/scrapers' }, ctx),
      readConnectors(get, ctx),
    ]);
    const scrapers = recordsAt(scraperBody, 'scrapers');
    const fields = ctx.isAdmin ? ADMIN_SCRAPER_FIELDS : SCRAPER_FIELDS;
    return { content: jsonResult({
      count: scrapers.length, scrapers: scrapers.map((s) => pick(s, fields, 300)), ...connectors,
    }) };
  });

  const status = serverTool('get_scraper_status', 'scrapers', toolSpec(
    'get_scraper_status',
    'Status of a scraper\u2019s latest run (status, pages scraped, items found, errors).',
    { scraper_id: idProperty('Scraper id.') },
    ['scraper_id'],
  ), async (input, ctx) => {
    const { scraper_id: scraperId } = parseToolInput(scraperIdInput, input);
    const body = await get({
      fn: 'scrapers',
      path: `/scrapers/${seg(scraperId)}/status`,
      resource: '/scrapers/{proxy+}',
      pathParameters: { proxy: `${scraperId}/status` },
    }, ctx);
    return { content: jsonResult(body) };
  });
  return [list, status, analyzeTool(deps)];
}

function settingsTools(deps: ToolDeps): ServerToolDefinition[] {
  const read = (name: 'categories' | 'brand') => async (input: unknown, ctx: AssistantRunContext) => {
    parseToolInput(noInput, input);
    return { content: jsonResult(await getSettingsRoute(deps, ctx, name)) };
  };
  return [
    serverTool('get_categories_config', 'settings', toolSpec(
      'get_categories_config',
      'The configured feedback categories and subcategories used by the enrichment pipeline.',
      {},
    ), read('categories')),
    serverTool('get_brand_settings', 'settings', toolSpec(
      'get_brand_settings',
      'Brand settings: brand name, handles, hashtags and URLs to track. Read before proposing save_brand_settings.',
      {},
    ), read('brand')),
  ];
}

export function createWorkspaceServerTools(deps: ToolDeps): ServerToolDefinition[] {
  const get = getter(deps);
  return [...formsTools(get), ...prioritizationTools(get), ...scrapersTools(get, deps), ...settingsTools(deps)];
}
