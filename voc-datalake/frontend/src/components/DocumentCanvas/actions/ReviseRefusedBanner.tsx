/**
 * @fileoverview A save the server would not record as a revision (400: its text no longer holds a change of the
 * pass, say): nothing was saved and the draft stays. The server's reason, and "Save as my own edit" (the same text, as
 * a plain edit). Announced as an alert; the button waits for a save on its way. (The stale-save banner is the shared
 * component's: components/Document/conflict/ConflictBanner.tsx.)
 *
 * @module components/DocumentCanvas/actions/ReviseRefusedBanner
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import type { ReviseRefused } from './useCanvasDocument'

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
        {saving ? t('documents:actions.status.saving') : t('canvas.revise.refused.saveAsOwn')}
      </button>
    </div>
  )
}
