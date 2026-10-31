/**
 * `insights` pack server tools — feedback lists, entities, resolved problems.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import type { JsonSchemaProperties } from '../spec.js';
import { recordsAt, summarizeFeedback, toFeedbackSources } from './feedback-shape.js';
import { serverTool, windowQuery } from './common.js';
import { labelResult } from './category-labels.js';
import { ITEM_FILTER_PROPERTIES, itemFilterShape } from './item-filters.js';
import { floorForRun, readLimitForRun } from './feedback-floor.js';
import { floorQuery, type FloorQueryOutcome, type RouteFloorField } from './floor-args.js';

const filterString = z.string().trim().min(1).max(100).optional();
const SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
const sentimentFilter = z.enum(SENTIMENTS).optional();

const urgentInput = z.object({
  limit: z.number().int().min(1).max(30).optional(),
  source: filterString,
  category: filterString,
  sentiment: sentimentFilter,
  ...itemFilterShape,
}).strict();

const listInput = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(5000).optional(),
  source: filterString,
  category: filterString,
  sentiment: sentimentFilter,
  ...itemFilterShape,
}).strict();

const entitiesInput = z.object({ source: filterString, ...itemFilterShape }).strict();

const resolvedSchema = z.object({ resolved: z.record(z.string(), z.unknown()).catch({}) }).loose();

const FILTER_PROPERTIES: JsonSchemaProperties = {
  source: { type: 'string', description: 'Source platform filter.' },
  category: { type: 'string', description: 'Category filter.' },
  sentiment: { type: 'string', enum: [...SENTIMENTS], description: 'Sentiment filter.' },
  ...ITEM_FILTER_PROPERTIES,
};

/** What /feedback and /feedback/urgent filter on; /feedback/entities takes no category or sentiment. */
const LIST_FLOOR_FIELDS: ReadonlySet<RouteFloorField> = new Set(['source', 'category', 'sentiment', 'channel', 'tag', 'dims', 'rating', 'urgent']);
const ENTITIES_FLOOR_FIELDS: ReadonlySet<RouteFloorField> = new Set(['source', 'channel', 'tag', 'dims', 'rating', 'urgent']);

/** The tool's filters under the user's floor (floor-args.ts): the query to send, or an empty answer. */
function flooredFilters(ctx: AssistantRunContext, args: z.infer<typeof listInput>, tool: string, fields: ReadonlySet<RouteFloorField>): FloorQueryOutcome {
  return floorQuery(floorForRun(ctx.page, ctx.props), args, tool, fields);
}

/** The page size within the /chat panel's reading cap; 0 = the cap is already spent at this offset. */
function cappedLimit(ctx: AssistantRunContext, limit: number, offset = 0): number {
  const cap = readLimitForRun(ctx.props);
  return cap === undefined ? limit : Math.max(0, Math.min(limit, cap - offset));
}

const CAP_SPENT = '\nThe user\u2019s chat scope caps a read at this many reviews, so no further page is read. Say so, '
  + 'and suggest narrowing the filters.\n';

function getUrgentFeedbackTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_urgent_feedback',
    'The newest HIGH-urgency feedback items in the page time window, optionally filtered. Use for "what needs '
      + 'attention now". The count is the page length, not a total — get_metrics(summary).urgent_count is the total.',
    { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max items (default 15).' }, ...FILTER_PROPERTIES },
  );
  return serverTool('get_urgent_feedback', 'insights', spec, async (input, ctx) => {
    const args = parseToolInput(urgentInput, input);
    const floored = flooredFilters(ctx, args, 'get_urgent_feedback', LIST_FLOOR_FIELDS);
    if (floored.kind === 'empty') return { content: floored.content };
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback/urgent',
      resource: '/feedback/urgent',
      query: { ...windowQuery(ctx), limit: cappedLimit(ctx, args.limit ?? 15), ...floored.query },
    }, ctx.claims);
    const items = recordsAt(body, 'items');
    return {
      content: jsonResult(await labelResult(
        deps, ctx, { returned: items.length, items: items.map((item) => summarizeFeedback(item, 400)) })),
      sources: toFeedbackSources(items),
    };
  });
}

function listFeedbackTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_feedback',
    'Page through the newest feedback in the page time window with exact source/category/sentiment/channel/tag/'
      + 'dimension filters. '
      + 'Returns `total` (matches in the scanned window) plus one page of items. Use search_feedback for text search.',
    {
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Page size (default 20).' },
      offset: { type: 'integer', minimum: 0, maximum: 5000, description: 'Items to skip.' },
      ...FILTER_PROPERTIES,
    },
  );
  return serverTool('list_feedback', 'insights', spec, async (input, ctx) => {
    const args = parseToolInput(listInput, input);
    const floored = flooredFilters(ctx, args, 'list_feedback', LIST_FLOOR_FIELDS);
    if (floored.kind === 'empty') return { content: floored.content };
    const limit = cappedLimit(ctx, args.limit ?? 20, args.offset);
    if (limit === 0) return { content: jsonResult({ returned: 0, items: [] }) + CAP_SPENT };
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback',
      resource: '/feedback',
      query: { ...windowQuery(ctx), limit, ...floored.query, offset: args.offset },
    }, ctx.claims);
    const items = recordsAt(body, 'items');
    const meta = isRecord(body) ? { total: body.total, offset: body.offset, is_partial_window: body.is_partial_window } : {};
    return {
      content: jsonResult(await labelResult(
        deps, ctx, { ...meta, returned: items.length, items: items.map((item) => summarizeFeedback(item, 300)) })),
      sources: toFeedbackSources(items),
    };
  });
}

function getEntitiesTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_entities',
    'Counts of categories, top recurring issues (problem summaries), persona buckets and sources in the page time '
      + 'window, plus channel, tag and dimension-value counts. Good for "what are people complaining about" overviews.',
    { source: { type: 'string', description: 'Source platform filter.' }, ...ITEM_FILTER_PROPERTIES },
  );
  return serverTool('get_entities', 'insights', spec, async (input, ctx) => {
    const args = parseToolInput(entitiesInput, input);
    const floored = flooredFilters(ctx, args, 'get_entities', ENTITIES_FLOOR_FIELDS);
    if (floored.kind === 'empty') return { content: floored.content };
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback/entities',
      resource: '/feedback/entities',
      query: { ...windowQuery(ctx), ...floored.query },
    }, ctx.claims);
    return { content: jsonResult(body) };
  });
}

function getResolvedProblemsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_resolved_problems',
    'The problem keys marked resolved on the Problem Analysis page (shared across users), with when. The same keys '
      + 'are what set_problem_resolved takes.',
    {},
  );
  return serverTool('get_resolved_problems', 'insights', spec, async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const body = await deps.invoke({
      fn: 'settings',
      method: 'GET',
      path: '/settings/resolved-problems',
      resource: '/settings/{proxy+}',
      pathParameters: { proxy: 'resolved-problems' },
    }, ctx.claims);
    const parsed = resolvedSchema.safeParse(body);
    const entries = Object.entries(parsed.success ? parsed.data.resolved : {}).map(([problemKey, value]) => ({
      problem_key: problemKey,
      resolved_at: isRecord(value) && typeof value.resolved_at === 'string' ? value.resolved_at : undefined,
    }));
    return { content: jsonResult({ count: entries.length, resolved: entries }) };
  });
}

export function createInsightsServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [
    getUrgentFeedbackTool(deps),
    listFeedbackTool(deps),
    getEntitiesTool(deps),
    getResolvedProblemsTool(deps),
  ];
}
