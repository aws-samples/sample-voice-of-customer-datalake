/**
 * @fileoverview A list of strings kept in this browser's localStorage under one key (a UI preference: who dismissed a
 * banner, which instances were answered). An absent, unreadable or drifted record reads as empty, never as an error.
 *
 * @module lib/storedStrings
 */

/** The strings stored under `key`, in order; `[]` when there is none or it cannot be read. */
export function readStoredStrings(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}
