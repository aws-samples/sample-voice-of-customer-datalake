/**
 * The cleanup an effect returns on a path where it set nothing up (typically its early return).
 *
 * An effect that returns a cleanup on one path returns one on every path (sonarjs/no-inconsistent-returns
 * in the lint gate), and `return undefined` is spelled plain `return` by unicorn/no-useless-undefined, so
 * this names the no-op instead: `if (!enabled) return noCleanup`.
 */
export function noCleanup(): void {
  // Nothing was set up on this path, so there is nothing to undo.
}
