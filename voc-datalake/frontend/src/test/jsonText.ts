/**
 * Spec helpers for values that must be text: a request body `fetchApi` / `fetch` sent, a tool message's
 * content. `String(value)` would turn an unexpected object into `[object Object]` and let the spec fail
 * with a JSON syntax error far from the cause; these fail at once, naming what arrived instead.
 */

/** `value` as the string it must be; throws a TypeError naming the type that arrived instead. */
export function asText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`expected a string, got ${value === null ? 'null' : typeof value}`)
  return value
}

/** The JSON a string value holds (a sent request body, a tool message's content). */
export function parsedJson(value: unknown): unknown {
  return JSON.parse(asText(value))
}
