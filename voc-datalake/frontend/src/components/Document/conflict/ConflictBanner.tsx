/**
 * @fileoverview The stale-save banner (a 409): someone saved the document after this draft was made on it. What
 * happened, and the three ways out: **Compare and merge** (D6-4: the latest version's changes taken into this draft
 * where they still apply, MergeDialog), **Load the latest** (this draft discarded) and **Save mine anyway** (saved
 * over it, unchecked; the other save stays in the history). While a save or a load is on its way all of them wait:
 * a second click never sends a second version, and no save lands under a load whose answer would put the older copy
 * back.
 *
 * @module components/Document/conflict/ConflictBanner
 */
import { AlertTriangle, GitMerge, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import { ignoreRejection } from '../../../lib/rejections'
import type { DocumentConflict } from '../types'

export function ConflictBanner({ conflict }: Readonly<{ conflict: DocumentConflict }>) {
  const { t } = useTranslation('documents')
  const { saving, loading, onCompare } = conflict
  const busy = saving || loading
  return (
    <div role="alert" aria-busy={busy} className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
      <span className="mr-auto">{t('conflict.title')}</span>
      {onCompare === undefined ? null : (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} aria-haspopup="dialog"
          onClick={() => { onCompare().catch(ignoreRejection) }}>
          <GitMerge size={14} aria-hidden="true" />{t('conflict.merge')}
        </button>
      )}
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void conflict.onLoadLatest()}>
        {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {t('conflict.loadLatest')}
      </button>
      {/* Bordered, like its neighbours: a ghost button's muted text misses AA on the warning tint. */}
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => saveIgnoringFailure(conflict.onSaveAnyway)}>
        {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {saving ? t('actions.status.saving') : t('conflict.saveAnyway')}
      </button>
    </div>
  )
}
