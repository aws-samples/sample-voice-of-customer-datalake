/**
 * Typed reads of a write tool's VALIDATED arguments for `write-requests.ts`.
 * The arguments already passed the tool's own zod schema; these accessors
 * re-check the one field they read, so a wrong type is an error, never a cast.
 */
import { isRecord } from '../../lib/is-record.js';

/** A write that cannot be built: unknown tool, wrong argument, missing current state. */
export class WriteRequestError extends Error {
  override readonly name = 'WriteRequestError';
}

export type Args = Readonly<Record<string, unknown>>;

export function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new WriteRequestError(`${key} must be a string`);
  return value;
}

export function optionalText(args: Args, key: string): string | undefined {
  return args[key] === undefined ? undefined : text(args, key);
}

export function optionalNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new WriteRequestError(`${key} must be a number`);
  return value;
}

export function record(args: Args, key: string): Record<string, unknown> {
  const value = args[key];
  if (!isRecord(value)) throw new WriteRequestError(`${key} must be an object`);
  return value;
}

export function textList(args: Args, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new WriteRequestError(`${key} must be a list of strings`);
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** `{key: value}` when value is defined, else `{}` — JSON.stringify drops undefined the same way. */
export function present(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

/** `args` without the keys whose value is undefined (what a JSON body carries). */
export function defined(args: Args): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}
