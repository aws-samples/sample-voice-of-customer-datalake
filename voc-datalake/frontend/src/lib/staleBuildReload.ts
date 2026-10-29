/**
 * @fileoverview Reload once when a tab opened before a deploy asks for a chunk the deploy removed.
 *
 * Every deploy replaces the hashed files in `/assets/` (the website upload prunes the old build). A tab
 * still running the previous build then asks for a lazy chunk that is gone; CloudFront answers its
 * SPA fallback, `index.html` with 200, and the browser refuses it ("Expected a JavaScript module
 * script but the server responded with a MIME type of text/html"). The page or tab never loads
 * (seen 2026-10-26: Administration → System → Version showed no changelog after the 5.36.02 deploy).
 *
 * Vite fires `vite:preloadError` on `window` when a dynamic import fails. A fresh load fetches the new
 * `index.html` and with it the current chunk names, so the fix is a reload. Once per build only: when the
 * reloaded page fails too (a real outage, not a stale tab), it is left to the page's own error state
 * instead of reloading in a loop.
 *
 * @module lib/staleBuildReload
 */

/** sessionStorage key holding the build (commit) that already reloaded once for a missing chunk. */
export const STALE_BUILD_RELOAD_KEY = 'voc-stale-build-reload'

interface ReloadDeps {
  readonly target: Pick<EventTarget, 'addEventListener'>
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  readonly reload: () => void
  /** The running build's identity (BUILD_COMMIT); a new build may reload once again. */
  readonly build: string
}

/**
 * Record that `build` reloads now; false when it already did, or when storage is blocked (then a
 * reload could never be told from a loop, so none happens).
 */
function claimReload(storage: ReloadDeps['storage'], build: string): boolean {
  try {
    if (storage.getItem(STALE_BUILD_RELOAD_KEY) === build) return false
    storage.setItem(STALE_BUILD_RELOAD_KEY, build)
    return true
  } catch {
    return false
  }
}

/** Listen for failed dynamic imports and reload once per build. */
export function installStaleBuildReload({ target, storage, reload, build }: ReloadDeps): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (!claimReload(storage, build)) return // already reloaded once: the page shows its own error
    event.preventDefault() // the reload handles it; no unhandled rejection for the dying page
    reload()
  })
}
