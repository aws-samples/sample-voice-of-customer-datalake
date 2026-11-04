/**
 * `search_feature_requests` (core pack, read-only): requests posted on the
 * feedback boards (docs/feature-requests.md), read from the engagement API
 * (`voc-engagement-api`, `GET /feature-requests/search`) as the caller, so the
 * route's board access (`shared/feature_boards_access.py`) applies exactly as
 * it does in the browser. Board requests are a SEPARATE evidence source: they
 * never enter voc-feedback, the feedback search tools never return them, and
 * the model cites them as `[FR:<request_id>]`, never as a review.
 *
 * Only the slim fields reach the model (the route's slim item has no email and
 * no name; `pick` drops anything added upstream). Not a plan read:
 * voc-plan-step holds no ENGAGEMENT_FUNCTION (plan-step/think.ts excludes it).
 */
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';
import type { ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import type { ApiCall } from '../internal-api.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult, pick } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { recordsAt } from './feedback-shape.js';
import { serverTool } from './common.js';

/** The slim item fields the model may read (contract C2). */
const FEATURE_REQUEST_FIELDS = [
  'request_id', 'board_id', 'title', 'description', 'status', 'supporters', 'category', 'sentiment',
  'problem_summary', 'created_at',
] as const;
/** The tool's page size (contract C6); the route itself allows up to 100. */
const MAX_FEATURE_REQUEST_LIMIT = 50;
const DEFAULT_LIMIT = 25;
/** The widest window a board answers (the insights route's 3650 days); 0 = all time. */
const MAX_DAYS = 3650;
const MAX_QUERY_CHARS = 200;
const MAX_FILTER_CHARS = 100;
/** A board, category or status list holds at most this many values (the route's comma list). */
const MAX_FILTER_VALUES = 20;
const MAX_FIELD_CHARS = 1000;
const RESULT_BUDGET = 40_000;

/** One value or a list of them; sent to the route as a comma list. A comma inside a value would split it. */
const filterSchema = z.union([
  z.string().trim().min(1).max(MAX_FILTER_CHARS),
  z.array(z.string().trim().min(1).max(MAX_FILTER_CHARS)).min(1).max(MAX_FILTER_VALUES),
]).refine((value) => (Array.isArray(value) ? value : [value]).every((part) => !part.includes(',')), 'a value may not contain a comma (pass a list)');

const searchInput = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS).optional(),
  board: filterSchema.optional(),
  category: filterSchema.optional(),
  status: filterSchema.optional(),
  days: z.number().int().min(0).max(MAX_DAYS).optional(),
  limit: z.number().int().min(1).max(MAX_FEATURE_REQUEST_LIMIT).optional(),
}).strict();
type SearchInput = z.infer<typeof searchInput>;

const FILTERS = ['board', 'category', 'status'] as const;

/** The route's query: `q`, comma lists, `days` only for a bounded window, the page size. */
function featureRequestSearchCall(input: SearchInput): ApiCall {
  const query: Record<string, string | number> = { limit: input.limit ?? DEFAULT_LIMIT };
  if (input.query !== undefined) query.q = input.query;
  for (const name of FILTERS) {
    const value = input[name];
    if (value !== undefined) query[name] = (Array.isArray(value) ? value : [value]).join(',');
  }
  if (input.days !== undefined && input.days > 0) query.days = input.days;
  return {
    fn: 'engagement',
    method: 'GET',
    path: '/feature-requests/search',
    resource: '/feature-requests/{proxy+}',
    pathParameters: { proxy: 'search' },
    query,
  };
}

/** The route's answer shaped for the model: slim fields only, a count the model can quote. */
function shapeFeatureRequestSearch(body: unknown): Record<string, unknown> {
  const items = recordsAt(body, 'items').map((item) => pick(item, FEATURE_REQUEST_FIELDS, MAX_FIELD_CHARS));
  const total = isRecord(body) && typeof body.total === 'number' ? body.total : items.length;
  const truncated = isRecord(body) && body.truncated === true;
  return { count: items.length, total, truncated, items };
}

const filterProperty = (what: string): DocumentType => ({
  anyOf: [
    { type: 'string', maxLength: MAX_FILTER_CHARS },
    { type: 'array', items: { type: 'string', maxLength: MAX_FILTER_CHARS }, minItems: 1, maxItems: MAX_FILTER_VALUES },
  ],
  description: `${what}: one value or a list (any of them).`,
});

export function createFeatureRequestServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [serverTool('search_feature_requests', 'core', toolSpec(
    'search_feature_requests',
    'Search the requests people posted on the feedback boards (feature requests, ideas), which the caller may see. '
      + 'These are board requests, NOT customer reviews: they are a separate source, never counted in review metrics and '
      + 'never returned by search_feedback. Each item: request_id, board_id, title, description, status, supporters '
      + '(+1 count), category, sentiment, problem_summary, created_at. Cite a request as [FR:<request_id>], never as a '
      + 'review, and say how many supporters it has when that matters. total and truncated say whether there are more.',
    {
      query: { type: 'string', maxLength: MAX_QUERY_CHARS, description: 'Words to look for in the title and description.' },
      board: filterProperty('Board id or slug'),
      category: filterProperty('Category name'),
      status: filterProperty('Request status, e.g. open, planned, shipped'),
      days: { type: 'integer', minimum: 0, maximum: MAX_DAYS, description: 'Only requests created in the last N days. 0 or absent = all time.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_FEATURE_REQUEST_LIMIT, description: `How many requests (default ${DEFAULT_LIMIT}).` },
    },
  ), async (input, ctx) => {
    const args = parseToolInput(searchInput, input);
    const body = await deps.invoke(featureRequestSearchCall(args), ctx.claims);
    return { content: jsonResult(shapeFeatureRequestSearch(body), RESULT_BUDGET) };
  })];
}
