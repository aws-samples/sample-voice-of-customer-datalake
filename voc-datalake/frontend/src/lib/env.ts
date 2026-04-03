/**
 * @fileoverview Environment variable access utilities.
 * @module lib/env
 */

/**
 * Safely read a Vite environment variable, returning a fallback
 * when the key is missing or not a string.
 */
export function getEnvString(key: string, defaultValue = ''): string {
  const value: unknown = import.meta.env[key]
  return typeof value === 'string' ? value : defaultValue
}
