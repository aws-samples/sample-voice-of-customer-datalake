/**
 * @fileoverview The ONE unsaved-changes guard every editor uses (E2E F6).
 *
 * An editor calls the hook with its dirty flag and its own save, and renders
 * `guard.dialog`. While dirty, the guard catches:
 *
 * - in-app route changes (react-router `useBlocker`; `shouldBlock` narrows it,
 *   e.g. to let a page switch between tabs that share the same draft),
 * - tab close / reload (`beforeunload`, the browser's own prompt — the only one
 *   a page may show there), registered only while dirty,
 * - anything else routed through `guard.requestLeave(action)` (closing an
 *   editor dialog, a page's local-state tabs via `useGuardedAction`).
 *
 * Each opens the same `UnsavedChangesDialog`: Save runs the editor's save and
 * proceeds only when it resolves true; Discard runs `onDiscard` and proceeds;
 * Cancel (or Escape) stays with the edits intact.
 *
 * `useBlocker` needs a data router. Page tests that render under a plain
 * `MemoryRouter` still get the dialog for `requestLeave` and `beforeunload` —
 * the blocker is a child component mounted only when a data router is present,
 * so the hook never calls `useBlocker` conditionally.
 *
 * @module components/UnsavedChangesGuard/useUnsavedChangesGuard
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { UNSAFE_DataRouterContext } from 'react-router-dom'
import RouterBlocker from './RouterBlocker'
import UnsavedChangesDialog from './UnsavedChangesDialog'
import { registerGuard } from './guardRegistry'
import type { ReactNode } from 'react'
import type { Location } from 'react-router-dom'
import type { PendingLeave as Pending } from './RouterBlocker'

export interface UnsavedChangesGuardOptions {
  /** The editor holds edits that are not saved. */
  readonly dirty: boolean
  /** The editor's own save. Resolve true on success; false or a rejection keeps the user here. */
  readonly onSave: () => Promise<boolean>
  /** Throw the edits away (optional: a route change unmounts the editor anyway). */
  readonly onDiscard?: () => void
  /** False when the draft cannot be saved as it stands (invalid): Save is disabled. */
  readonly canSave?: boolean
  /** Which route changes need the dialog. Default: any change of path or query. */
  readonly shouldBlock?: (current: Location, next: Location) => boolean
}

export interface UnsavedChangesGuard {
  /** Run `action` now when clean, or after Save/Discard in the dialog. */
  readonly requestLeave: (action: () => void) => void
  /** Render once, anywhere in the editor. */
  readonly dialog: ReactNode
}

const pathOrQueryChanged = (current: Location, next: Location): boolean =>
  current.pathname !== next.pathname || current.search !== next.search

function useBeforeUnload(active: boolean): void {
  useEffect(() => {
    if (!active) return
    // preventDefault is what current browsers need for their own "Leave site?" prompt.
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}

export function useUnsavedChangesGuard({
  dirty, onSave, onDiscard, canSave = true, shouldBlock = pathOrQueryChanged,
}: UnsavedChangesGuardOptions): UnsavedChangesGuard {
  const inDataRouter = useContext(UNSAFE_DataRouterContext) !== null
  const [pending, setPending] = useState<Pending | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // Read at decision time, so the blocker and the registry never act on a stale render.
  const latest = useRef({ dirty, onSave, onDiscard, shouldBlock })
  useEffect(() => {
    latest.current = { dirty, onSave, onDiscard, shouldBlock }
  })

  useBeforeUnload(dirty)

  const open = useCallback((next: Pending) => {
    setSaveFailed(false)
    setPending(next)
  }, [])
  const requestLeave = useCallback((action: () => void) => {
    if (!latest.current.dirty) action()
    else open({ proceed: action, stay: () => undefined })
  }, [open])

  useEffect(() => registerGuard({ isDirty: () => latest.current.dirty, requestLeave }), [requestLeave])

  const blockWhen = useCallback(
    (current: Location, next: Location) => latest.current.dirty && latest.current.shouldBlock(current, next),
    [],
  )

  const close = (leave: boolean) => {
    if (pending === null) return
    setPending(null)
    if (leave) pending.proceed()
    else pending.stay()
  }
  const save = async () => {
    setSaving(true)
    setSaveFailed(false)
    const ok = await latest.current.onSave().catch(() => false)
    setSaving(false)
    if (ok) close(true)
    else setSaveFailed(true)
  }
  const discard = () => {
    latest.current.onDiscard?.()
    close(true)
  }

  return {
    requestLeave,
    dialog: (
      <>
        {inDataRouter && <RouterBlocker when={blockWhen} onBlocked={open} />}
        <UnsavedChangesDialog
          isOpen={pending !== null}
          saving={saving}
          saveFailed={saveFailed}
          canSave={canSave}
          onSave={() => { void save() }}
          onDiscard={discard}
          onCancel={() => close(false)}
        />
      </>
    ),
  }
}
