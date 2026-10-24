/**
 * @fileoverview The unsaved-changes guard for an editor DIALOG whose edits are
 * one value: dirty = the value differs from what it was when the dialog opened.
 *
 * Returns `close` — the dialog's every exit (Cancel, the X, Escape, backdrop)
 * should call it: it closes at once when clean, and asks Save / Discard /
 * Cancel otherwise — plus `dialog`, rendered once inside the editor.
 *
 * @module components/UnsavedChangesGuard/useSnapshotGuard
 */
import { useState } from 'react'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'

export function useSnapshotGuard<T>({ value, onSave, onClose, canSave = true }: Readonly<{
  /** The editor's current value (compared structurally with the opening one). */
  value: T
  /** The host's save: resolves on success, rejects on failure. */
  onSave: () => Promise<unknown>
  onClose: () => void
  canSave?: boolean
}>) {
  const [initial] = useState(() => JSON.stringify(value))
  const guard = useUnsavedChangesGuard({
    dirty: JSON.stringify(value) !== initial,
    canSave,
    onSave: async () => {
      await onSave()
      return true
    },
  })
  return { close: () => guard.requestLeave(onClose), dialog: guard.dialog }
}

/** Fire the host's save from a button: a failure stays on screen (the host owns the error). */
export function saveIgnoringFailure(save: () => Promise<unknown> | undefined): void {
  Promise.resolve(save()).catch(() => undefined)
}
