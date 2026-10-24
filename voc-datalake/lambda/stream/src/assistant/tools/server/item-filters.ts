/**
 * The post-query item filters every feedback list / urgent / entities / metrics
 * route takes (docs/dimensions.md): `channel` (exact `source_channel`), `tag`
 * (item `tags` contains it, case-insensitive) and `dims` — an object here,
 * serialised to the routes' `key:value,key:value` query parameter.
 *
 * The key / value patterns and the 10-pair cap mirror
 * lambda/shared/dimension_config.py (DIMENSION_KEY_RE, DIMENSION_VALUE_RE,
 * MAX_DIMENSIONS); the route re-validates and answers 400 on a malformed `dims`.
 */
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';
import type { JsonSchemaProperties } from '../spec.js';

export const DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const DIMENSION_VALUE_PATTERN = /^[^\s#,:]{1,64}$/;
const MAX_DIMENSION_FILTERS = 10;
const MAX_FILTER_LENGTH = 64;

const filterText = z.string().trim().min(1).max(MAX_FILTER_LENGTH).optional();

const dimsFilterSchema = z.record(
  z.string().regex(DIMENSION_KEY_PATTERN),
  z.string().trim().regex(DIMENSION_VALUE_PATTERN),
).refine((dims) => Object.keys(dims).length <= MAX_DIMENSION_FILTERS, {
  message: `dims takes at most ${MAX_DIMENSION_FILTERS} key/value pairs`,
});

/** Spread into a tool's strict zod input object. */
export const itemFilterShape = {
  channel: filterText,
  tag: filterText,
  dims: dimsFilterSchema.optional(),
};

export interface ItemFilterArgs {
  channel?: string;
  tag?: string;
  dims?: Record<string, string>;
}

const DIMS_PROPERTY: DocumentType = {
  type: 'object',
  maxProperties: MAX_DIMENSION_FILTERS,
  additionalProperties: { type: 'string' },
  description: 'Dimension filters {key: value} (keys and values from list_dimensions); every pair must match.',
};

/** JSON-schema fragment for the model-facing filter arguments. */
export const ITEM_FILTER_PROPERTIES: JsonSchemaProperties = {
  channel: { type: 'string', description: 'Channel filter (the item source_channel, e.g. "email", "chat").' },
  tag: { type: 'string', description: 'Tag filter (case-insensitive).' },
  dims: DIMS_PROPERTY,
};

/** `{product: 'app', module: 'billing'}` -> `product:app,module:billing`; empty -> undefined. */
export function serializeDims(dims: Readonly<Record<string, string>> | undefined): string | undefined {
  const pairs = Object.entries(dims ?? {}).map(([key, value]) => `${key}:${value}`);
  return pairs.length > 0 ? pairs.join(',') : undefined;
}

/** The query parameters for the filters (undefined ones are dropped by the invoke layer). */
export function itemFilterQuery(args: ItemFilterArgs): { channel?: string; tag?: string; dims?: string } {
  return { channel: args.channel, tag: args.tag, dims: serializeDims(args.dims) };
}
