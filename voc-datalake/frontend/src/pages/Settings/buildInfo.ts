/**
 * @fileoverview The build stamps shown on Administration → System → Version.
 *
 * vite.config.ts stamps them with `define` at build (or dev-server start):
 * the repo-root package.json version, the short git commit ('unknown' without
 * git) and the build time in ISO UTC. vitest.config.ts pins fixed values, so
 * specs see the same stamps on every run.
 *
 * @module pages/Settings/buildInfo
 */

declare global {
  interface ImportMetaEnv {
    readonly PLATFORM_VERSION: string
    readonly BUILD_COMMIT: string
    readonly BUILD_TIME: string
  }
}

export interface BuildInfo {
  /** SemVer as in package.json, e.g. `3.12.0`. */
  readonly version: string
  /** Short git sha, or `unknown`. */
  readonly commit: string
  /** ISO 8601 UTC timestamp of the build. */
  readonly builtAt: string
}

export const BUILD_INFO: BuildInfo = {
  version: import.meta.env.PLATFORM_VERSION,
  commit: import.meta.env.BUILD_COMMIT,
  builtAt: import.meta.env.BUILD_TIME,
}

/** `3.12.0` → `3.12.00`: the CHANGELOG's two-digit minor and patch. Anything else is returned as is. */
export function paddedVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) return version
  const [, major, minor, patch] = match
  return `${major}.${(minor ?? '').padStart(2, '0')}.${(patch ?? '').padStart(2, '0')}`
}

/** `2026-01-02T03:04:05.000Z` → `2026-01-02 03:04 UTC`; an unparseable stamp is returned as is. */
export function formatBuildTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
