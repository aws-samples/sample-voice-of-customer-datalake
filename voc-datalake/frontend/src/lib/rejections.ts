/**
 * Named `.catch()` handlers for the few places where a rejection leaves nothing to handle.
 *
 * The lint gate bans an inline `.catch(() => undefined)`, `.catch(() => null)` or `.catch(() => {})`
 * (SWALLOWED_REJECTION_SELECTORS in eslint-rules/quality-gates.mjs), so every dropped rejection is a
 * visible decision: handle, log or rethrow the error where that matters, and use one of these only when
 * the failure truly has no consequence. Say at the call site why it does not matter.
 */

/** For best-effort work whose failure leaves the screen as it is (a retry, a cancel, a copy). */
export function ignoreRejection(): void {
  // Intentionally empty: the caller documents why the failure needs no handling.
}

/** For an optional value: a rejection reads as "no value" (`null`). */
export function nullOnRejection(): null {
  return null
}
