/**
 * @fileoverview Build-time environment access.
 *
 * Its own module (not part of `runtimeConfig.ts`) because many specs replace
 * `runtimeConfig` with a partial `vi.mock` factory while loading the real
 * config store, which reads the env at creation.
 */

/** A `VITE_*` build-time variable as a string (`defaultValue` when unset or not a string). */
export function getEnvString(key: string, defaultValue = ''): string {
  const value: unknown = import.meta.env[key]
  return typeof value === 'string' ? value : defaultValue
}
