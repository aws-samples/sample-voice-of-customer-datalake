/**
 * The canvas's stale-save banner (409): someone saved the document after this page loaded
 * it. What happened, and the two ways out (same pattern as the workflow editor). While a
 * save or a load is on its way both wait for it: a second click never sends a second
 * version, and no save lands under a load whose answer would put the older copy back.
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import type { ReviseRefused } from './useCanvasDocument'

export interface DocumentConflict {
  readonly onLoadLatest: () => Promise<unknown>
  readonly onSaveAnyway: () => Promise<unknown>
  /** A save is on its way (this one, or the page's). */
  readonly saving: boolean
  /** "Load the latest" is on its way. */
  readonly loading: boolean
}

export function ConflictBanner({ conflict }: Readonly<{ conflict: DocumentConflict }>) {
  const { t } = useTranslation('projectDetail')
  const { saving, loading } = conflict
  const busy = saving || loading
  return (
    <div role="alert" aria-busy={busy} className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
      <span className="mr-auto">{t('documentModal.conflict')}</span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void conflict.onLoadLatest()}>
        {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {t('documentModal.conflictReload')}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => saveIgnoringFailure(conflict.onSaveAnyway)}>
        {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {saving ? t('canvas.actions.status.saving') : t('documentModal.conflictSaveAnyway')}
      </button>
    </div>
  )
}

/**
 * A save the server would not record as a revision (400: its text no longer holds a change of the pass, say):
 * nothing was saved and the draft stays. The server's reason, and "Save as my own edit" (the same text, as a plain
 * edit). Announced as an alert; the button waits for a save on its way.
 */
export function ReviseRefusedBanner({ refused }: Readonly<{ refused: ReviseRefused }>) {
  const { t } = useTranslation('projectDetail')
  const { saving } = refused
  return (
    <div role="alert" aria-busy={saving} data-testid="canvas-revise-refused"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
      <span className="mr-auto min-w-0 break-words">
        {refused.message ?? t('canvas.revise.refused.fallback')} {t('canvas.revise.refused.explain')}
      </span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => saveIgnoringFailure(refused.onSaveAsOwnEdit)}>
        {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {saving ? t('canvas.actions.status.saving') : t('canvas.revise.refused.saveAsOwn')}
      </button>
    </div>
  )
}
