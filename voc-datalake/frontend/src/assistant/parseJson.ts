/**
 * @fileoverview JSON text → value, or undefined when it is not JSON (tool results, stored content).
 *
 * @module assistant/parseJson
 */
export function jsonOrUndefined(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}
