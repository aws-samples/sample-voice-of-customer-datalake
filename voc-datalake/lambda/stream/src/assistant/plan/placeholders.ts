/**
 * Placeholders inside a plan step's arguments: every string leaf of `args`
 * (objects and arrays, any depth) classified as a literal, a `{{free}}` marker,
 * a `{{step.output}}` reference, or malformed (any other `{{` / `}}`).
 *
 * LOCKSTEP: `frontend/src/assistant/plan/placeholders.ts` mirrors this file.
 */
import { FREE_PLACEHOLDER, REFERENCE_RE } from './schema.js';

export type PlaceholderLeaf =
  | { kind: 'free'; path: readonly (string | number)[] }
  | { kind: 'reference'; path: readonly (string | number)[]; step: string; output: string }
  | { kind: 'malformed'; path: readonly (string | number)[] };

function classify(value: string, path: readonly (string | number)[]): PlaceholderLeaf | undefined {
  if (value === FREE_PLACEHOLDER) return { kind: 'free', path };
  const match = REFERENCE_RE.exec(value);
  if (match?.[1] !== undefined && match[2] !== undefined) return { kind: 'reference', path, step: match[1], output: match[2] };
  if (value.includes('{{') || value.includes('}}')) return { kind: 'malformed', path };
  return undefined;
}

/** Every placeholder (and malformed placeholder) under `value`, in document order. */
export function findPlaceholders(value: unknown, path: readonly (string | number)[] = []): PlaceholderLeaf[] {
  if (typeof value === 'string') {
    const leaf = classify(value, path);
    return leaf === undefined ? [] : [leaf];
  }
  if (Array.isArray(value)) return value.flatMap((item: unknown, index) => findPlaceholders(item, [...path, index]));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, member]) => findPlaceholders(member, [...path, key]));
  }
  return [];
}

/** `value` with every placeholder string replaced by `dummy` (for the literal check). */
export function substitutePlaceholders(value: unknown, dummy: string): unknown {
  if (typeof value === 'string') return classify(value, []) === undefined ? value : dummy;
  if (Array.isArray(value)) return value.map((item: unknown) => substitutePlaceholders(item, dummy));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, substitutePlaceholders(member, dummy)]));
  }
  return value;
}

/** `a.b.0.c` — the field name used in validation errors and FREE_TEXT_FIELDS. */
export function dottedPath(path: readonly (string | number | symbol)[]): string {
  return path.map(String).join('.');
}

/** True when `path` equals `prefix` or lies under it. */
export function isUnder(path: readonly (string | number | symbol)[], prefix: readonly (string | number)[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => String(path[index]) === String(part));
}
