/**
 * Matching — the security core of a plan write (docs/assistant-plan-mode.md →
 * "Matching"). Pure functions over the step's DECLARED arguments:
 *
 *   1. `resolveReferences`: every `{{sN.output}}` from the recorded outputs of
 *      earlier steps (ids in `resolved`, text in `think_outputs`); a missing
 *      one fails the step;
 *   2. `freePaths` / `withFreeValues`: the `{{free}}` fields, filled with the
 *      text the step agent wrote — nothing else;
 *   3. `matchesDefinition`: the FINAL (schema-parsed) arguments are the
 *      declared ones exactly — every literal identical, every reference equal
 *      to its resolved value, every other value one of the declared free
 *      fields — compared as canonical JSON, so no extra key, no changed target.
 */
import { canonicalJson } from '../assistant/plan/canonical.js';
import { findPlaceholders } from '../assistant/plan/placeholders.js';
import { FREE_PLACEHOLDER, REFERENCE_RE } from '../assistant/plan/schema.js';
import { isRecord } from '../lib/is-record.js';

type Path = readonly (string | number)[];

export type Resolution = { ok: true; args: Record<string, unknown> } | { ok: false; missing: string };

/** Replace each leaf string by `replace(leaf)` (objects and arrays, any depth). */
function mapLeaves(value: unknown, replace: (leaf: string, path: Path) => unknown, path: Path = []): unknown {
  if (typeof value === 'string') return replace(value, path);
  if (Array.isArray(value)) return value.map((item: unknown, index) => mapLeaves(item, replace, [...path, index]));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, mapLeaves(member, replace, [...path, key])]));
  return value;
}

/** The declared args with every reference replaced by its recorded value. */
export function resolveReferences(
  declared: Record<string, unknown>,
  resolved: Readonly<Record<string, string>>,
  thinkOutputs: Readonly<Record<string, string>>,
): Resolution {
  const missing: string[] = [];
  const args = mapLeaves(declared, (leaf) => {
    const match = REFERENCE_RE.exec(leaf);
    if (match === null) return leaf;
    const key = `${match[1] ?? ''}.${match[2] ?? ''}`;
    const value = resolved[key] ?? thinkOutputs[key];
    if (value === undefined) missing.push(key);
    return value ?? leaf;
  });
  if (missing.length > 0) return { ok: false, missing: missing.join(', ') };
  return isRecord(args) ? { ok: true, args } : { ok: false, missing: 'arguments' };
}

/** Dotted paths of the declared `{{free}}` fields. */
export function freePaths(declared: Record<string, unknown>): string[] {
  return findPlaceholders(declared).filter((leaf) => leaf.kind === 'free').map((leaf) => leaf.path.join('.'));
}

/** The args with each `{{free}}` leaf replaced by the step agent's text for its path (absent → left as the marker). */
export function withFreeValues(args: Record<string, unknown>, values: Readonly<Record<string, string>>): Record<string, unknown> {
  const filled = mapLeaves(args, (leaf, path) => (leaf === FREE_PLACEHOLDER ? values[path.join('.')] ?? leaf : leaf));
  return isRecord(filled) ? filled : args;
}

function child(node: unknown, part: string | number): unknown {
  if (Array.isArray(node)) return node[Number(part)];
  return isRecord(node) ? node[String(part)] : undefined;
}

function valueAtPath(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(child, value);
}

/**
 * True when `final` is exactly the declared arguments with references resolved
 * and the free fields holding strings. `resolvedArgs` = `resolveReferences`'s
 * output (free markers still in place).
 */
/** Stands for a free field the final args do not fill with text (so the comparison fails). */
const UNFILLED = '{{unfilled}}';

export function matchesDefinition(resolvedArgs: Record<string, unknown>, final: Record<string, unknown>): boolean {
  const expected = mapLeaves(resolvedArgs, (leaf, path) => {
    if (leaf !== FREE_PLACEHOLDER) return leaf;
    const written = valueAtPath(final, path);
    return typeof written === 'string' ? written : UNFILLED;
  });
  try {
    return canonicalJson(expected) === canonicalJson(final);
  } catch {
    return false;
  }
}
