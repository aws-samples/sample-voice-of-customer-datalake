/**
 * @fileoverview Re-base an editor's draft onto a fresh server copy WITHOUT
 * losing the user's edits (E2E 3.00.00 R2).
 *
 * An editor that seeds its draft from a query must not simply replace the
 * draft when the query's data changes: the first load can land after the user
 * has started typing (the inputs are editable while it loads), and a refetch
 * can land while the unsaved-changes dialog is open. Replacing the draft then
 * silently threw the edits away, so the form went clean, Cancel "kept" nothing
 * and the next navigation was no longer guarded.
 *
 * `rebaseDraft` merges field by field instead: a field the user has not
 * touched (it still equals the previous server copy) follows the new server
 * copy; a field the user edited keeps the edit. The new server copy becomes
 * the reference, so `dirty` stays "the draft differs from what is stored".
 *
 * @module components/UnsavedChangesGuard/rebaseDraft
 */

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The draft over `next`: each of `keys` keeps the draft's value when the user
 * changed it from `previous`, and takes `next`'s value otherwise.
 */
export function rebaseDraft<T extends object>(
  previous: T,
  next: T,
  draft: T,
  keys: ReadonlyArray<keyof T>,
): T {
  const merged: T = { ...next }
  for (const key of keys) {
    if (!sameValue(draft[key], previous[key])) merged[key] = draft[key]
  }
  return merged
}
