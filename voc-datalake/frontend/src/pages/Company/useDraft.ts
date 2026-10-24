/**
 * @fileoverview A local edit draft over server data.
 *
 * The draft is null until the user edits, so the form shows the server value
 * (and follows refetches) until then; after a successful save `reset()` drops
 * the draft and the refreshed server value shows again. `dirty` drives the
 * save button and the unsaved-changes guard: it is true only when what Save
 * would send differs from the saved value, so adding then removing a row (or
 * adding a blank one the save drops) is not a change.
 *
 * @module pages/Company/useDraft
 */
import { useState } from 'react'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * @param server  the saved value
 * @param toSaved what Save would send for a value (the section's PUT body builder,
 *                which drops blank rows); identity when omitted
 */
export function useDraft<T>(server: T, toSaved: (value: T) => unknown = (value) => value) {
  const [draft, setDraft] = useState<T | null>(null)
  const value = draft ?? server
  return {
    value,
    dirty: draft !== null && !sameValue(toSaved(draft), toSaved(server)),
    /** Always an updater, so a draft built from several edits never reads a stale value. */
    update: (change: (current: T) => T) => setDraft((current) => change(current ?? server)),
    reset: () => setDraft(null),
  }
}

/**
 * The shared unsaved-changes guard over a `useDraft` (E2E F6): Save runs the
 * section's own save, Discard drops the draft. Render `guard.dialog` once.
 */
export function useDraftGuard({ dirty, reset, save, canSave = true }: Readonly<{
  dirty: boolean
  reset: () => void
  /** The section's save (a mutation's `mutateAsync`): resolves on success. */
  save: () => Promise<unknown>
  canSave?: boolean
}>) {
  return useUnsavedChangesGuard({
    dirty,
    canSave,
    onSave: async () => {
      await save()
      return true
    },
    onDiscard: reset,
  })
}
