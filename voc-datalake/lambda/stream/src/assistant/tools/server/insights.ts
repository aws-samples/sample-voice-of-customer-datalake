/**
 * `insights` pack server tools — feedback lists, entities, resolved problems.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { isRecord, jsonResult } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import type { JsonSchemaProperties } from '../spec.js';
import { recordsAt, summarizeFeedback, toFeedbackSources } from './feedback-shape.js';
import { serverTool, windowQuery } from './common.js';
import { ITEM_FILTER_PROPERTIES, itemFilterQuery, itemFilterShape } from './item-filters.js';

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

/** The window, page size and every filter of a /feedback or /feedback/urgent read. */
function feedbackListQuery(ctx: AssistantRunContext, args: z.infer<typeof urgentInput>, defaultLimit: number) {
  return {
    ...windowQuery(ctx),
    limit: args.limit ?? defaultLimit,
    source: args.source,
    category: args.category,
    sentiment: args.sentiment,
    ...itemFilterQuery(args),
  };
}

function getUrgentFeedbackTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_urgent_feedback',
    'The newest HIGH-urgency feedback items in the page time window, optionally filtered. Use for "what needs '
      + 'attention now". The count is the page length, not a total — get_metrics(summary).urgent_count is the total.',
    { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max items (default 15).' }, ...FILTER_PROPERTIES },
  );
  return serverTool('get_urgent_feedback', 'insights', spec, async (input, ctx) => {
    const args = parseToolInput(urgentInput, input);
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback/urgent',
      resource: '/feedback/urgent',
      query: feedbackListQuery(ctx, args, 15),
    }, ctx.claims);
    const items = recordsAt(body, 'items');
    return {
      content: jsonResult({ returned: items.length, items: items.map((item) => summarizeFeedback(item, 400)) }),
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
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback',
      resource: '/feedback',
      query: { ...feedbackListQuery(ctx, args, 20), offset: args.offset },
    }, ctx.claims);
    const items = recordsAt(body, 'items');
    const meta = isRecord(body) ? { total: body.total, offset: body.offset, is_partial_window: body.is_partial_window } : {};
    return {
      content: jsonResult({ ...meta, returned: items.length, items: items.map((item) => summarizeFeedback(item, 300)) }),
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
    const body = await deps.invoke({
      fn: 'metrics',
      method: 'GET',
      path: '/feedback/entities',
      resource: '/feedback/entities',
      query: { ...windowQuery(ctx), source: args.source, ...itemFilterQuery(args) },
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
