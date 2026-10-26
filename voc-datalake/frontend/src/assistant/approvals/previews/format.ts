/**
 * @fileoverview Pure helpers shared by the approval previews (kept out of the
 * component modules so those export components only).
 *
 * @module assistant/approvals/previews/format
 */

/** Strings longer than this collapse to an excerpt with a "show more" toggle. */
export const LONG_TEXT_CHARS = 280

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Field name → human label: `brand_handles` → `Brand handles`. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Structural equality for JSON-shaped values (field before/after comparison). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
