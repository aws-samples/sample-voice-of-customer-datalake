/**
 * @fileoverview The initial-load effect body the Product tab's panels share.
 *
 * Both load one resource on mount with the promise-callback lifecycle pattern:
 * every setState happens asynchronously in `.then` / `.finally`, each guarded
 * by a flag the cleanup flips so an unmounted panel is never updated.
 */

interface LoadHandlers<T> {
  /** Adopts the response; skipped once the effect has been cleaned up. */
  readonly onLoaded: (response: T) => void
  /** Logged with the error when the request fails. */
  readonly errorMessage: string
  /** Clears the loading state; skipped once the effect has been cleaned up. */
  readonly onSettled: () => void
}

/**
 * Runs `request` for the lifetime of an effect. Returns the cleanup that stops
 * its handlers from touching state after unmount, so the call site reads
 * `useEffect(() => loadWhileMounted(...), [deps])`.
 */
export function loadWhileMounted<T>(request: Promise<T>, handlers: LoadHandlers<T>): () => void {
  const lifecycle = { cancelled: false }
  request.then((response) => {
    if (!lifecycle.cancelled) handlers.onLoaded(response)
  }).catch((e: unknown) => {
    console.error(handlers.errorMessage, e)
  }).finally(() => {
    if (!lifecycle.cancelled) handlers.onSettled()
  })
  return () => { lifecycle.cancelled = true }
}
