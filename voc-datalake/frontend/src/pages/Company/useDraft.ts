/**
 * @fileoverview A local edit draft over server data.
 *
 * The draft is null until the user edits, so the form shows the server value
 * (and follows refetches) until then; after a successful save `reset()` drops
 * the draft and the refreshed server value shows again. `dirty` drives the
 * save button.
 *
 * @module pages/Company/useDraft
 */
import { useState } from 'react'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'

export function useDraft<T>(server: T) {
  const [draft, setDraft] = useState<T | null>(null)
  const value = draft ?? server
  return {
    value,
    dirty: draft !== null,
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
