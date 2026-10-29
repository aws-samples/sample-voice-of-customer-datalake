/**
 * @fileoverview Pure helpers shared by the approval previews (kept out of the
 * component modules so those export components only).
 *
 * @module assistant/approvals/previews/format
 */
import { sameJson } from '../../../lib/sameJson'
import type { ReactNode } from 'react'
import type { FieldRow } from './FieldDiff'

/** Strings longer than this collapse to an excerpt with a "show more" toggle. */
export const LONG_TEXT_CHARS = 280

/** A table row compared by its key alone (a value with no stored counterpart). */
export const fieldRow = (key: string, label: string, value: ReactNode): FieldRow => ({ key, label, value, compare: key })

/** Field name → human label: `brand_handles` → `Brand handles`. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Structural equality for JSON-shaped values (field before/after comparison); absent equals null. */
export function sameValue(a: unknown, b: unknown): boolean {
  return sameJson(a ?? null, b ?? null)
}
