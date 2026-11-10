/**
 * The feedback floor: the filters the user has on screen, as a hard lower bound on what the
 * feedback-reading tools may read (docs/assistant-chat-scope.md).
 *
 * Two inputs, one vocabulary (the contract's PAGE_FILTER_KEYS, the page URL's own spelling):
 * `page.filters` (Categories, Problem Analysis) and `forwardedProps.scope.filters` (the /chat
 * filter panel). Both are floors, so when both are sent they intersect. The model may narrow
 * within the floor with its own arguments, never widen it: a tool ANDs the floor with what the
 * model asked for, so an argument outside the floor matches nothing rather than being obeyed.
 *
 * Not floors: `resolved` and `similarity` (how Problem Analysis groups, not which reviews it
 * reads), and the time window, which stays `forwardedProps.days` and the tools' own `days`
 * argument ("the last 90 days" asked on a 7-day page reads 90 days, 5.35).
 *
 * The values are user data. They are matched and echoed back to the model as data (JSON
 * strings in tool results), never placed in the system prompt.
 */
import { CHAT_SCOPE_MAX_ITEMS, type ForwardedProps, type PageContext } from '../../contract.js';

type PageFilters = NonNullable<PageContext['filters']>;

/** The list-valued fields of a floor, by their PAGE_FILTER_KEYS / tool-argument name. */
export const FLOOR_LIST_FIELDS = ['source', 'category', 'subcategory', 'sentiment', 'usefulness', 'channel', 'tag'] as const;
export type FloorListField = (typeof FLOOR_LIST_FIELDS)[number];

/** Fields whose page value may name several choices, comma-separated (`?category=a,b`). */
const COMMA_LIST_FIELDS = new Set<FloorListField>(['source', 'category', 'subcategory', 'sentiment', 'usefulness']);

/** `usefulness=unrated` admits a review stored without a band (shared/usefulness.py USEFULNESS_UNRATED). */
const USEFULNESS_UNRATED = 'unrated';

/**
 * The values the read routes accept for the closed-vocabulary fields (shared/item_facets.py
 * SENTIMENT_VALUES / USEFULNESS_VALUES); any other value answers 400 there. A floor keeps only
 * these, so a hand-edited URL (`?sentiment=all`) can neither turn every read into an error nor
 * widen the floor: with no known value left the field admits nothing.
 */
const KNOWN_VALUES: Partial<Record<FloorListField, ReadonlySet<string>>> = {
  sentiment: new Set(['positive', 'neutral', 'negative', 'mixed']),
  usefulness: new Set(['low', 'medium', 'high', USEFULNESS_UNRATED]),
};

/** `dims=key:a|b` accepts either value; `~unset` accepts an item with no value (shared/item_filters.py). */
export const DIMS_ANY_SEPARATOR = '|';
const DIMS_UNSET_VALUE = '~unset';
const MIN_STARS = 1;
const MAX_STARS = 5;
const URGENT_ON = new Set(['1', 'true']);

export interface FeedbackFloor {
  /** Allowed values per field; absent = any value. An EMPTY list admits nothing (two floors that do not overlap). */
  readonly lists: Readonly<Partial<Record<FloorListField, readonly string[]>>>;
  /** Allowed values per dimension key (lower-cased; `~unset` = no value). An empty list admits nothing. */
  readonly dims: Readonly<Record<string, readonly string[]>>;
  readonly ratingMin?: number;
  readonly ratingMax?: number;
  readonly urgent: boolean;
  /** Search texts (`q`); an item must contain every one. */
  readonly queries: readonly string[];
}

export const NO_FLOOR: FeedbackFloor = { lists: {}, dims: {}, urgent: false, queries: [] };

function uniqueTrimmed(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))];
}

function listOf(field: FloorListField, raw: string): string[] {
  const values = uniqueTrimmed(COMMA_LIST_FIELDS.has(field) ? raw.split(',') : [raw]);
  const known = KNOWN_VALUES[field];
  return known === undefined ? values : values.filter((value) => known.has(value));
}

/**
 * `key:a|b,key2:c` → `{key: ['a', 'b'], key2: ['c']}`. A pair that does not parse keeps its raw
 * text as a key with no allowed value, so it admits nothing (fail closed: a dropped pair would widen).
 */
function parseDims(raw: string): Record<string, string[]> {
  const dims: Record<string, string[]> = {};
  for (const pair of raw.split(',')) {
    const text = pair.trim();
    if (text === '') continue;
    const colon = text.indexOf(':');
    const key = colon > 0 ? text.slice(0, colon).trim() : text;
    const values = colon > 0 ? uniqueTrimmed(text.slice(colon + 1).split(DIMS_ANY_SEPARATOR)) : [];
    dims[key] = values.map((value) => value.toLowerCase());
  }
  return dims;
}

/** `rating=1…5` (+ `rating_dir=below` = at most); anything else is "any rating", as the page reads it. */
function parseRating(filters: PageFilters): Pick<FeedbackFloor, 'ratingMin' | 'ratingMax'> {
  const stars = Number(filters.rating);
  if (!Number.isInteger(stars) || stars < MIN_STARS || stars > MAX_STARS) return {};
  return filters.rating_dir === 'below' ? { ratingMax: stars } : { ratingMin: stars };
}

/** One filter set (a page's or the chat panel's) as a floor. */
export function floorFromFilters(filters: PageFilters | undefined): FeedbackFloor {
  if (filters === undefined) return NO_FLOOR;
  const lists: Partial<Record<FloorListField, string[]>> = {};
  for (const field of FLOOR_LIST_FIELDS) {
    const raw = filters[field];
    if (raw !== undefined) lists[field] = listOf(field, raw);
  }
  const query = filters.q?.trim() ?? '';
  return {
    lists,
    dims: filters.dims === undefined ? {} : parseDims(filters.dims),
    ...parseRating(filters),
    urgent: URGENT_ON.has((filters.urgent ?? '').trim().toLowerCase()),
    queries: query === '' ? [] : [query],
  };
}

function intersectList(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((value) => b.includes(value));
}

function tighterMin(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

function tighterMax(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}

/** Both floors at once: every list and dimension intersected, the tighter rating bounds, either urgent. */
export function intersectFloors(a: FeedbackFloor, b: FeedbackFloor): FeedbackFloor {
  const lists: Partial<Record<FloorListField, readonly string[]>> = {};
  for (const field of FLOOR_LIST_FIELDS) {
    const merged = intersectList(a.lists[field], b.lists[field]);
    if (merged !== undefined) lists[field] = merged;
  }
  const dims: Record<string, readonly string[]> = { ...a.dims };
  for (const [key, values] of Object.entries(b.dims)) dims[key] = intersectList(dims[key], values) ?? values;
  const ratingMin = tighterMin(a.ratingMin, b.ratingMin);
  const ratingMax = tighterMax(a.ratingMax, b.ratingMax);
  return {
    lists,
    dims,
    ...(ratingMin === undefined ? {} : { ratingMin }),
    ...(ratingMax === undefined ? {} : { ratingMax }),
    urgent: a.urgent || b.urgent,
    queries: [...a.queries, ...b.queries],
  };
}

/** The run's floor: the page's filters AND the chat panel's scope. */
export function floorForRun(page: PageContext, props: Pick<ForwardedProps, 'scope'>): FeedbackFloor {
  return intersectFloors(floorFromFilters(page.filters), floorFromFilters(props.scope?.filters));
}

/**
 * How many reviews one feedback read may use: the chat panel's `limit` (default and maximum
 * CHAT_SCOPE_MAX_ITEMS) when the panel sent a scope, else undefined (the tools' own caps, as before).
 */
export function readLimitForRun(props: Pick<ForwardedProps, 'scope'>): number | undefined {
  if (props.scope === undefined) return undefined;
  return Math.min(props.scope.limit ?? CHAT_SCOPE_MAX_ITEMS, CHAT_SCOPE_MAX_ITEMS);
}

export function isEmptyFloor(floor: FeedbackFloor): boolean {
  return Object.keys(floor.lists).length === 0 && Object.keys(floor.dims).length === 0
    && floor.ratingMin === undefined && floor.ratingMax === undefined && !floor.urgent && floor.queries.length === 0;
}

/** The item fields the floor reads (a subset of the stream's FeedbackItem). */
export interface FloorItem {
  source_platform?: string;
  category?: string;
  subcategory?: string;
  sentiment_label?: string;
  /** The stored usefulness band (`low` / `medium` / `high`); absent = unrated. */
  usefulness?: string | null;
  source_channel?: string | null;
  tags?: string[] | null;
  dimensions?: Record<string, string> | null;
  rating?: number | null;
  urgency?: string;
  original_text?: string;
  title?: string;
  problem_summary?: string;
}

const ITEM_FIELD: Record<Exclude<FloorListField, 'tag' | 'usefulness'>, keyof FloorItem> = {
  source: 'source_platform',
  category: 'category',
  subcategory: 'subcategory',
  sentiment: 'sentiment_label',
  channel: 'source_channel',
};

function admitsList(item: FloorItem, field: FloorListField, allowed: readonly string[]): boolean {
  if (field === 'tag') {
    const tags = (item.tags ?? []).map((tag) => tag.toLowerCase());
    return allowed.some((tag) => tags.includes(tag.toLowerCase()));
  }
  if (field === 'usefulness') {
    const band = typeof item.usefulness === 'string' && item.usefulness !== '' ? item.usefulness : USEFULNESS_UNRATED;
    return allowed.includes(band);
  }
  const value = item[ITEM_FIELD[field]];
  return typeof value === 'string' && allowed.includes(value);
}

function admitsDims(item: FloorItem, dims: FeedbackFloor['dims']): boolean {
  return Object.entries(dims).every(([key, allowed]) => {
    const value = item.dimensions?.[key];
    if (value === undefined || value === '') return allowed.includes(DIMS_UNSET_VALUE);
    return allowed.includes(value.toLowerCase());
  });
}

function admitsRating(item: FloorItem, floor: FeedbackFloor): boolean {
  if (floor.ratingMin === undefined && floor.ratingMax === undefined) return true;
  const rating = item.rating;
  if (typeof rating !== 'number' || Number.isNaN(rating)) return false;
  return (floor.ratingMin === undefined || rating >= floor.ratingMin)
    && (floor.ratingMax === undefined || rating <= floor.ratingMax);
}

function containsText(item: FloorItem, query: string): boolean {
  const q = query.toLowerCase();
  return [item.original_text, item.title, item.problem_summary].some((text) => (text ?? '').toLowerCase().includes(q));
}

/** Whether one review is inside the floor (AND across fields, OR within one). */
export function admitsFloor(floor: FeedbackFloor, item: FloorItem): boolean {
  const listsPass = FLOOR_LIST_FIELDS.every((field) => {
    const allowed = floor.lists[field];
    return allowed === undefined || admitsList(item, field, allowed);
  });
  return listsPass
    && admitsDims(item, floor.dims)
    && admitsRating(item, floor)
    && (!floor.urgent || item.urgency === 'high')
    && floor.queries.every((query) => containsText(item, query));
}

/** The floor as data for a tool result (JSON-safe; values are the user's, quoted by the caller's JSON). */
export function describeFloor(floor: FeedbackFloor): Record<string, unknown> {
  return {
    ...floor.lists,
    ...(Object.keys(floor.dims).length > 0 ? { dims: floor.dims } : {}),
    ...(floor.ratingMin === undefined ? {} : { rating_min: floor.ratingMin }),
    ...(floor.ratingMax === undefined ? {} : { rating_max: floor.ratingMax }),
    ...(floor.urgent ? { urgent: true } : {}),
    ...(floor.queries.length > 0 ? { text: floor.queries } : {}),
  };
}
