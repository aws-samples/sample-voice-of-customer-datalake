/**
 * @fileoverview Shared `window.location` helper for suites that depend on the
 * document origin.
 *
 * The trusted-origin check (issue #262) resolves relative URLs against
 * `window.location.origin`, so any suite exercising it needs the origin to be a
 * known quantity rather than whatever the previously-run file left behind.
 * Vitest shares one jsdom environment across files
 * (`poolOptions.forks.singleFork`), and several suites replace
 * `window.location` with partial stubs.
 *
 * `src/test/setup.ts` restores `window.location` after every test as a global
 * safety net; this helper is the positive half — it sets the origin a suite
 * needs. Keeping it here rather than copied per-file means the two suites that
 * use it cannot drift apart.
 */
import { beforeEach } from 'vitest'

/** The document origin these suites assume when resolving relative URLs. */
export const APP_ORIGIN = 'http://localhost:3000'

/**
 * Pin `window.location` to {@link APP_ORIGIN} before each test in the calling
 * suite. Restoration is handled by the global `afterEach` in `setup.ts`, so a
 * suite that uses this helper cannot leak its stub into later files.
 *
 * Call at `describe` body level, alongside the suite's other hooks.
 */
export function useAppOrigin(): void {
  beforeEach(() => {
    setLocationOrigin(APP_ORIGIN)
  })
}

/**
 * Replace `window.location` with a stub reporting `origin`.
 *
 * Exposed for the cases that need an origin other than {@link APP_ORIGIN} — for
 * example asserting that a missing or opaque origin fails closed.
 */
export function setLocationOrigin(origin: string): void {
  Object.defineProperty(window, 'location', {
    value: { origin, href: `${origin}/` },
    writable: true,
    configurable: true,
  })
}
