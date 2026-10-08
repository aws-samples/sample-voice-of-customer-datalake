/**
 * `core` pack server tools — available on every page.
 */
import { EventType, type CustomEvent } from '@ag-ui/core';
import { z } from 'zod';
import { CUSTOM_EVENTS } from '../../contract.js';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { isRecord, jsonResult, pick, withinBudget } from '../format.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { searchFeedbackSpec, webSearchSpec } from './search-specs.js';
import { recordsAt, summarizeFeedback, toFeedbackSource, toFeedbackSources } from './feedback-shape.js';
import { getProjectRoute, getSettingsRoute, seg, serverTool, windowDaysProperty, windowDaysSchema, windowQuery } from './common.js';
import { summarizeProject } from './project-shape.js';
import { readCategoryScope, readVisibleCategories } from './category-access.js';
import { DIMENSION_KEY_PATTERN, ITEM_FILTER_PROPERTIES, itemFilterQuery, itemFilterShape } from './item-filters.js';

const METRICS = ['summary', 'sentiment', 'categories', 'sources', 'personas', 'github', 'dimensions'] as const;
/** Every metric route takes channel / tags / dims; all but github (always github_issues) take `source`. */
const UNSOURCED_METRICS = new Set<string>(['github']);

const metricsInput = z.object({
  metric: z.enum(METRICS),
  days: windowDaysSchema.optional(),
  source: z.string().trim().min(1).max(100).optional(),
  key: z.string().trim().regex(DIMENSION_KEY_PATTERN).optional(),
  ...itemFilterShape,
}).strict().refine((args) => args.metric !== 'dimensions' || args.key !== undefined, {
  message: 'the dimensions metric needs `key` (a dimension key from list_dimensions)',
  path: ['key'],
});

type MetricsArgs = z.infer<typeof metricsInput>;

function metricsQuery(ctx: AssistantRunContext, args: MetricsArgs) {
  return {
    ...windowQuery(ctx, args.days),
    source: UNSOURCED_METRICS.has(args.metric) ? undefined : args.source,
    ...itemFilterQuery(args),
    key: args.metric === 'dimensions' ? args.key : undefined,
  };
}

const feedbackItemInput = z.object({
  feedback_id: idSchema.optional(),
  include_similar: z.boolean().optional(),
}).strict();

const projectInput = z.object({ project_id: idSchema.optional() }).strict();

const navigationInput = z.object({
  path: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(80),
}).strict();

/** SPA routes a navigation chip may point at (`:id` = one plain id segment). */
const NAVIGATION_ROUTES: readonly RegExp[] = [
  /^\/$/,
  /^\/dashboard$/,
  /^\/feedback\/[\w.:-]{1,128}$/,
  /^\/categories$/,
  /^\/problems$/,
  /^\/projects$/,
  /^\/projects\/[\w.:-]{1,128}$/,
  /^\/prioritization$/,
  /^\/data-explorer$/,
  /^\/scrapers$/,
  /^\/feedback-forms$/,
  /^\/settings$/,
  /^\/memory$/,
  /^\/agents$/,
  /^\/agents\/[\w.:-]{1,128}$/,
];

export function isAllowedNavigationPath(path: string): boolean {
  return NAVIGATION_ROUTES.some((route) => route.test(path));
}

/** The record entries of `projects`; any other body (or a non-array `projects`) reads as none. */
const projectsListSchema = z.object({
  projects: z.array(z.unknown()).transform((items) => items.filter(isRecord)),
}).catch({ projects: [] });

function searchFeedbackTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('search_feedback', 'core', searchFeedbackSpec(), async (input, ctx) => {
    // Before any read: a scope that cannot be read fails the tool (closed).
    const scope = await readCategoryScope(deps, ctx);
    const result = await deps.searchFeedback(isRecord(input) ? input : {}, {
      scope,
      days: ctx.props.days,
      dateBasis: ctx.props.dateBasis,
    });
    return { content: withinBudget(result.formatted), sources: toFeedbackSources(result.items.slice(0, 5)) };
  });
}

function getMetricsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_metrics',
    'Pre-computed dashboard metrics over the whole dataset for a time window: summary (totals, average sentiment, '
      + 'urgent count, daily series), sentiment, categories, sources or personas breakdown, dimensions (counts and '
      + 'sentiment per value of one dimension, `key` from list_dimensions), or github (GitHub Issues per '
      + 'software release and per label: volume, sentiment, top complaints/errors, what is new in the latest release). '
      + 'Exact counts — prefer this '
      + 'over searching for "how many" / distribution questions. The window defaults to the page time range.',
    {
      metric: { type: 'string', enum: [...METRICS], description: 'Which breakdown to read.' },
      days: windowDaysProperty('Window in days (default: page time range).'),
      source: { type: 'string', description: 'Source platform filter (every metric except github, which is GitHub Issues only).' },
      key: { type: 'string', description: 'Dimension key; required for metric=dimensions.' },
      ...ITEM_FILTER_PROPERTIES,
    },
    ['metric'],
  );
  return serverTool('get_metrics', 'core', spec, async (input, ctx) => {
    const args = parseToolInput(metricsInput, input);
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: `/metrics/${args.metric}`,
      resource: '/metrics/{proxy+}',
      pathParameters: { proxy: args.metric },
      query: metricsQuery(ctx, args),
    }, ctx.claims);
    const partial = isRecord(body) && body.is_partial === true
      ? '\n⚠️ is_partial=true: the figures are a lower bound for this window — say so.'
      : '';
    return { content: jsonResult(body) + partial };
  });
}

async function readSimilar(deps: ToolDeps, feedbackId: string, ctx: AssistantRunContext) {
  const body = await deps.invoke({
    fn: 'metrics',
    method: 'GET',
    path: `/feedback/${seg(feedbackId)}/similar`,
    resource: '/feedback/{id}/similar',
    pathParameters: { id: feedbackId },
    query: { limit: 5 },
  }, ctx.claims);
  return recordsAt(body, 'items');
}

function getFeedbackItemTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_feedback_item',
    'Read one feedback item in full (defaults to the item open on the current page), optionally with similar items '
      + 'from the same category.',
    {
      feedback_id: idProperty('Feedback id; omit to use the item on screen.'),
      include_similar: { type: 'boolean', description: 'Also return up to 5 similar items.' },
    },
  );
  return serverTool('get_feedback_item', 'core', spec, async (input, ctx) => {
    const args = parseToolInput(feedbackItemInput, input);
    const feedbackId = resolveId(args.feedback_id, ctx.page.feedbackId, 'feedback_id');
    const item = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: `/feedback/${seg(feedbackId)}`,
      resource: '/feedback/{id}',
      pathParameters: { id: feedbackId },
    }, ctx.claims);
    if (!isRecord(item)) throw new AssistantToolError('unavailable', 'The feedback item could not be read.');
    const similar = args.include_similar === true ? await readSimilar(deps, feedbackId, ctx) : undefined;
    const source = toFeedbackSource(item);
    return {
      content: jsonResult({
        item: summarizeFeedback(item, 4000),
        ...(similar === undefined ? {} : { similar: similar.map((s) => summarizeFeedback(s, 300)) }),
      }),
      sources: [...(source ? [source] : []), ...(similar === undefined ? [] : toFeedbackSources(similar))],
    };
  });
}

function listCategoriesTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_categories',
    'The feedback categories the signed-in user can see: name (the id used in filters and in '
      + 'set_feedback_category), description, the product it belongs to, and its subcategories. Read this before '
      + 'proposing a category change or filtering by category.',
    {},
  );
  return serverTool('list_categories', 'core', spec, async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const { restricted, categories } = await readVisibleCategories(deps, ctx);
    return {
      content: jsonResult({
        count: categories.length,
        ...(restricted ? { note: 'Only the categories this user may see are listed.' } : {}),
        categories,
      }),
    };
  });
}

function listDimensionsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_dimensions',
    'The feedback dimensions an admin configured (e.g. product, module, user type): key, label, description, '
      + 'parent dimension and allowed values. Read this before filtering with `dims` or reading '
      + 'get_metrics(metric="dimensions").',
    {},
  );
  return serverTool('list_dimensions', 'core', spec, async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    return { content: jsonResult(await getSettingsRoute(deps, ctx, 'dimensions')) };
  });
}

function listProjectsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_projects',
    'List the research projects the user can see (id, name, description, status, persona/document counts).',
    {},
  );
  return serverTool('list_projects', 'core', spec, async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const body = await deps.invoke({ fn: 'projects', method: 'GET', path: '/projects', resource: '/projects' }, ctx.claims);
    const projects = projectsListSchema.parse(body).projects.map((project) => pick(project, [
      'project_id', 'name', 'description', 'status', 'persona_count', 'document_count', 'updated_at', 'access',
    ], 300));
    return { content: jsonResult({ count: projects.length, projects }) };
  });
}

function getProjectTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_project',
    'Overview of one project (defaults to the project open on the current page): the signed-in user\u2019s access '
      + '(role, can_edit, can_manage), metadata, its personas (id, name, tagline) and its documents (id, title, type, '
      + 'size). Does not return document text — use get_documents for that.',
    { project_id: idProperty('Project id; omit to use the project on screen.') },
  );
  return serverTool('get_project', 'core', spec, async (input, ctx) => {
    const args = parseToolInput(projectInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const body = await getProjectRoute(deps, ctx, projectId);
    const summary = summarizeProject(body);
    ctx.projectAccess.record(projectId, summary.access);
    return { content: jsonResult(summary) };
  });
}

function suggestNavigationTool(): ServerToolDefinition {
  const spec = toolSpec(
    'suggest_navigation',
    'Offer the user a link chip to another page of the app (e.g. "/projects/<id>", "/feedback/<id>", "/problems"). '
      + 'Only app routes are accepted. The user decides whether to follow it.',
    {
      path: { type: 'string', description: 'App route, e.g. /projects/proj_123 or /categories.' },
      label: { type: 'string', maxLength: 80, description: 'Short link text.' },
    },
    ['path', 'label'],
  );
  return serverTool('suggest_navigation', 'core', spec, async (input, ctx) => {
    const args = parseToolInput(navigationInput, input);
    if (!isAllowedNavigationPath(args.path)) {
      throw new AssistantToolError('invalid_input', `"${args.path.slice(0, 80)}" is not an app route that can be linked.`);
    }
    const event: CustomEvent = {
      type: EventType.CUSTOM,
      name: CUSTOM_EVENTS.navigation,
      value: { path: args.path, label: args.label },
    };
    ctx.emit(event);
    return { content: `A link to "${args.label}" (${args.path}) is shown to the user.` };
  });
}

function webSearchTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('web_search', 'core', webSearchSpec(), async (input) => {
    const result = await deps.webSearch(input);
    return {
      content: withinBudget(result.content),
      webSources: result.webSources
        .filter((source) => source.url !== '')
        .map((source) => ({ title: source.title || source.url, url: source.url })),
    };
  });
}

export function createCoreServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [
    searchFeedbackTool(deps),
    getMetricsTool(deps),
    getFeedbackItemTool(deps),
    listProjectsTool(deps),
    getProjectTool(deps),
    suggestNavigationTool(),
    webSearchTool(deps),
    listCategoriesTool(deps),
    listDimensionsTool(deps),
  ];
}
