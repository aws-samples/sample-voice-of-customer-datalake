/**
 * Server tools for the `forms`, `prioritization`, `scrapers` and `settings`
 * packs — small read-only views of the corresponding admin/workspace pages.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ApiCall } from '../internal-api.js';
import type { ToolDeps } from '../deps.js';
import { isRecord, jsonResult, pick } from '../format.js';
import { idProperty, idSchema, parseToolInput, toolSpec } from '../spec.js';
import { recordsAt, toFeedbackSources } from './feedback-shape.js';
import { getSettingsRoute, seg, serverTool } from './common.js';

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

/** Scraper configs are stored verbatim; only these keys reach the model (no headers, cookies or selectors). */
const SCRAPER_FIELDS = [
  'id', 'name', 'enabled', 'base_url', 'urls', 'frequency_minutes', 'extraction_method', 'template', 'last_run', 'items_found',
] as const;

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

function prioritizationTools(get: Invoke): ServerToolDefinition[] {
  return [serverTool('get_prioritization', 'prioritization', toolSpec(
    'get_prioritization',
    'The prioritization board: each row (a project\u2019s set of documents), the signed-in user\u2019s own scores and '
      + 'the team aggregate (mean impact, time to market, confidence, strategic fit; reviewer count; spread). Use '
      + 'list_projects to name the projects.',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const body = await get({ fn: 'projects', path: '/projects/prioritization', resource: '/projects/prioritization' }, ctx);
    return { content: jsonResult(body) };
  })];
}

function scrapersTools(get: Invoke): ServerToolDefinition[] {
  const list = serverTool('list_scrapers', 'scrapers', toolSpec(
    'list_scrapers',
    'Configured web scrapers (id, name, enabled, target URLs, schedule, last run).',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const scrapers = recordsAt(await get({ fn: 'scrapers', path: '/scrapers', resource: '/scrapers' }, ctx), 'scrapers');
    return { content: jsonResult({ count: scrapers.length, scrapers: scrapers.map((s) => pick(s, SCRAPER_FIELDS, 300)) }) };
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
  return [list, status];
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
  return [...formsTools(get), ...prioritizationTools(get), ...scrapersTools(get), ...settingsTools(deps)];
}
