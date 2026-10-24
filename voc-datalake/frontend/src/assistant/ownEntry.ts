/**
 * @fileoverview Read an id-keyed record without falling through to the
 * prototype (`"constructor"`, `"toString"` …): the thread keeps tool results,
 * sources and resolutions in plain objects keyed by server-chosen ids.
 *
 * @module assistant/ownEntry
 */

/** The record's own value at `key`, or `undefined` when it has none. */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
