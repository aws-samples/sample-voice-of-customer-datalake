/**
 * @fileoverview Shared runtime type guard utilities.
 * @module lib/typeGuards
 */

/** Checks if a value is a non-null, non-array object (i.e. a plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Filters `null` out of a list with the element type narrowed (`list.filter(isPresent)`). */
export function isPresent<T>(value: T | null): value is T {
  return value !== null
}
