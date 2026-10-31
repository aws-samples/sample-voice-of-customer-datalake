/**
 * The model's filter arguments against the user's floor (feedback-floor.ts).
 *
 * search_feedback reads rows itself and ANDs the floor in its predicate; this module only names
 * the arguments that fell outside it, so the result can say why they matched nothing.
 *
 * The REST-backed tools (list_feedback, get_urgent_feedback, get_entities, get_metrics) send
 * single-valued query parameters, so `floorQuery` turns floor + arguments into the parameters to
 * send: an argument inside the floor narrows, one outside it is an empty intersection (the route
 * is not called), and no argument sends the floor's own value. What a route cannot express is
 * refused rather than dropped, because dropping it would widen what the user set: several
 * allowed values of one parameter (call once per value), or a field the route does not filter on.
 */
import { AssistantToolError } from '../errors.js';
import { serializeDims } from './item-filters.js';
import {
  DIMS_ANY_SEPARATOR, FLOOR_LIST_FIELDS, describeFloor, isEmptyFloor,
  type FeedbackFloor, type FloorListField,
} from './feedback-floor.js';

/** The filter arguments a feedback tool may take (each tool takes a subset). */
export interface FloorArgs {
  source?: string;
  category?: string;
  subcategory?: string;
  sentiment?: string;
  channel?: string;
  tag?: string;
  /** search_feedback's urgency level; the floor's urgent admits only `high`. */
  urgency?: string;
  dims?: Readonly<Record<string, string>>;
}

export interface FloorConflict {
  readonly field: string;
  readonly asked: string;
  readonly allowed: readonly string[];
}

function listConflict(field: FloorListField, asked: string | undefined, allowed: readonly string[] | undefined): FloorConflict[] {
  if (asked === undefined || allowed === undefined) return [];
  const inside = field === 'tag'
    ? allowed.some((value) => value.toLowerCase() === asked.toLowerCase())
    : allowed.includes(asked);
  return inside ? [] : [{ field, asked, allowed }];
}

function dimsConflicts(floor: FeedbackFloor, dims: FloorArgs['dims']): FloorConflict[] {
  return Object.entries(dims ?? {}).flatMap(([key, asked]) => {
    const allowed = floor.dims[key];
    return allowed === undefined || allowed.includes(asked.toLowerCase())
      ? []
      : [{ field: `dims.${key}`, asked, allowed }];
  });
}

/** The arguments the model passed that lie outside the floor (an empty list = all inside). */
export function floorConflicts(floor: FeedbackFloor, args: FloorArgs): FloorConflict[] {
  const urgency = floor.urgent && args.urgency !== undefined && args.urgency !== 'high'
    ? [{ field: 'urgency', asked: args.urgency, allowed: ['high'] }]
    : [];
  return [
    ...FLOOR_LIST_FIELDS.flatMap((field) => listConflict(field, args[field], floor.lists[field])),
    ...urgency,
    ...dimsConflicts(floor, args.dims),
  ];
}

/**
 * The paragraph a floored result ends with: which filters held, and which arguments matched
 * nothing because they asked past them. Empty without a floor (today's results, unchanged).
 */
export function floorNote(floor: FeedbackFloor, conflicts: readonly FloorConflict[]): string {
  if (isEmptyFloor(floor)) return '';
  const held = `\nThese results are limited to the filters the user set: ${JSON.stringify(describeFloor(floor))}. `
    + 'Nothing outside them was read; you may narrow within them but not widen them.';
  if (conflicts.length === 0) return `${held}\n`;
  return `${held} These arguments are outside those filters, so they matched nothing: ${JSON.stringify(conflicts)}. `
    + 'Tell the user their filters exclude it and that they can change the filters to include it.\n';
}

// ── REST-backed tools ──

/** What a route can filter on besides the window. */
export type RouteFloorField = FloorListField | 'dims' | 'rating' | 'urgent' | 'text';

/** The query parameters a floored REST read sends (undefined ones are dropped by the invoke layer). */
export interface FloorQuery {
  source?: string;
  category?: string;
  sentiment?: string;
  channel?: string;
  tag?: string;
  dims?: string;
  rating_min?: number;
  rating_max?: number;
  urgent?: string;
}

export type FloorQueryOutcome =
  | { readonly kind: 'query'; readonly query: FloorQuery }
  | { readonly kind: 'empty'; readonly content: string };

type QueryListField = 'source' | 'category' | 'sentiment' | 'channel' | 'tag';
const QUERY_LIST_FIELDS: readonly QueryListField[] = ['source', 'category', 'sentiment', 'channel', 'tag'];

function unsupported(tool: string, field: string): AssistantToolError {
  return new AssistantToolError('invalid_input', `The filters the user set include ${field}, which ${tool} cannot apply, `
    + 'so it would read past them. Use search_feedback instead (mode="aggregate" for counts).');
}

/** The value to send for one single-valued parameter, or null for an empty intersection. */
function narrowOne(tool: string, field: QueryListField, asked: string | undefined, allowed: readonly string[] | undefined): string | null | undefined {
  if (allowed === undefined) return asked;
  if (asked !== undefined) return listConflict(field, asked, allowed).length === 0 ? asked : null;
  if (allowed.length === 0) return null;
  if (allowed.length === 1) return allowed[0];
  throw new AssistantToolError('invalid_input', `The filters the user set allow several values of ${field} `
    + `(${JSON.stringify(allowed)}); ${tool} takes one. Call it once per value, passing ${field}.`);
}

/** `dims` to send: the model's pairs inside the floor plus the floor's own keys; null = empty intersection. */
function narrowDims(floor: FeedbackFloor, asked: FloorArgs['dims']): string | null | undefined {
  if (dimsConflicts(floor, asked).length > 0) return null;
  const merged: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(floor.dims)) {
    if (allowed.length === 0) return null;
    merged[key] = allowed.join(DIMS_ANY_SEPARATOR);
  }
  return serializeDims({ ...merged, ...asked });
}

const NO_OVERLAP = 'The filters the user set do not overlap (two filter sets that exclude each other), so nothing can match.\n';

function emptyOutcome(floor: FeedbackFloor, args: FloorArgs): FloorQueryOutcome {
  const conflicts = floorConflicts(floor, args);
  const note = floorNote(floor, conflicts) + (conflicts.length === 0 ? NO_OVERLAP : '');
  return { kind: 'empty', content: JSON.stringify({ returned: 0, items: [] }) + note };
}

/** Every field the floor narrows by, with the name a refusal gives it. */
function activeFields(floor: FeedbackFloor): [RouteFloorField, string][] {
  const fields: [RouteFloorField, string][] = FLOOR_LIST_FIELDS
    .filter((field) => floor.lists[field] !== undefined)
    .map((field) => [field, field]);
  if (Object.keys(floor.dims).length > 0) fields.push(['dims', 'dims']);
  if (floor.ratingMin !== undefined || floor.ratingMax !== undefined) fields.push(['rating', 'rating']);
  if (floor.urgent) fields.push(['urgent', 'urgent']);
  if (floor.queries.length > 0) fields.push(['text', 'a search text (q)']);
  return fields;
}

function checkSupported(floor: FeedbackFloor, tool: string, supported: ReadonlySet<RouteFloorField>): void {
  const missing = activeFields(floor).find(([field]) => !supported.has(field));
  if (missing !== undefined) throw unsupported(tool, missing[1]);
}

/**
 * The query parameters for a REST read under the floor. Throws (a tool error the model reads)
 * for what the route cannot express; answers `empty` when the floor and the arguments do not overlap.
 */
export function floorQuery(
  floor: FeedbackFloor,
  args: FloorArgs,
  tool: string,
  supported: ReadonlySet<RouteFloorField>,
): FloorQueryOutcome {
  checkSupported(floor, tool, supported);
  const query: FloorQuery = {};
  for (const field of QUERY_LIST_FIELDS) {
    const value = narrowOne(tool, field, args[field], floor.lists[field]);
    if (value === null) return emptyOutcome(floor, args);
    if (value !== undefined) query[field] = value;
  }
  const dims = narrowDims(floor, args.dims);
  if (dims === null) return emptyOutcome(floor, args);
  if (dims !== undefined) query.dims = dims;
  if (floor.ratingMin !== undefined) query.rating_min = floor.ratingMin;
  if (floor.ratingMax !== undefined) query.rating_max = floor.ratingMax;
  if (floor.urgent) query.urgent = '1';
  return { kind: 'query', query };
}
