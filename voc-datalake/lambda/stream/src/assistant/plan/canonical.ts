/**
 * Canonical JSON for plan fingerprints — byte-identical to
 * `lambda/shared/plan_schema.py::canonical_json`.
 *
 * Rules: object keys sorted by Unicode code point, no whitespace, strings as
 * `JSON.stringify` writes them (UTF-8, only `"` `\\` and C0 controls escaped),
 * integers in decimal, other finite numbers as ECMAScript `Number#toString`
 * (Python reproduces it), `undefined` object members dropped. Non-finite
 * numbers, lone surrogates and other value types are refused, so both sides
 * either agree or both throw.
 *
 * LOCKSTEP: `frontend/src/assistant/plan/canonical.ts` mirrors this file.
 */

/** Thrown for a value that has no canonical form. */
export class CanonicalJsonError extends Error {}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function codePointCompare(a: string, b: string): number {
  // Array.from iterates a string by code point (like a spread), so astral characters stay whole.
  const left = Array.from(a);
  const right = Array.from(b);
  const index = left.findIndex((char, position) => char !== right[position]);
  if (index === -1) return left.length - right.length;
  return (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
}

function canonicalString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError('lone surrogate in a string');
  return JSON.stringify(value);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number');
  return Object.is(value, -0) ? '0' : String(value);
}

function canonicalObject(value: object): string {
  const entries = Object.entries(value).filter(([, member]) => member !== undefined);
  entries.sort(([a], [b]) => codePointCompare(a, b));
  const members = entries.map(([key, member]) => `${canonicalString(key)}:${canonicalJson(member)}`);
  return `{${members.join(',')}}`;
}

/** The canonical JSON text of a JSON-like value. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') return canonicalObject(value);
  throw new CanonicalJsonError(`no canonical form for ${typeof value}`);
}

/** The text a write fingerprint hashes: `{"args":…,"tool":…}` in canonical form. */
export function canonicalWriteText(tool: string, args: Record<string, unknown>): string {
  return canonicalJson({ tool, args });
}
