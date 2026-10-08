/**
 * Test support: runtime narrowing for synthesized CloudFormation JSON.
 *
 * Templates arrive as `unknown`-ish JSON, and the repo convention is to narrow
 * with guards rather than `as` assertions. One body here instead of a private
 * copy in every suite.
 */

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk `keys` into `value`, returning the object found there or `undefined`
 * when any step is missing or is not an object.
 */
export function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

/**
 * The element at `index` (negative counts from the end, like `Array.at`),
 * failing loudly when it is absent so a test reports "no such item" instead
 * of a `TypeError` on `undefined` further down.
 */
export function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, found ${items.length} item(s)`);
  }
  return item;
}

/** `value`, failing loudly with `what` named when it is `undefined`. */
export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}

/** The value under `key`, failing loudly (with `message`, when given) when the key is missing. */
export function valueAt<T>(record: Readonly<Record<string, T>>, key: string, message?: string): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(message ?? `expected a value under key "${key}"`);
  }
  return value;
}
