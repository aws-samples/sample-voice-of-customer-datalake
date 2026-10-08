/**
 * Reading untyped CDK context (`-c key=value`, cdk.json) and environment values.
 *
 * Both arrive untyped (`tryGetContext` returns `any`), and an empty value has
 * always meant "unset" in this app (`-c brandName=` keeps the default), so these
 * helpers spell that rule once instead of relying on `||` truthiness.
 */

/** `value` when it is a non-empty string, else `fallback`. */
export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** `value` when it is a plain (non-array) object, else an empty record. */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
