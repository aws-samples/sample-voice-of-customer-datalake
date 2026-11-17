/**
 * @fileoverview The surface's own save row (a feature without a bar of its own): the save status (Saving…, Unsaved
 * changes, Saved), Discard and Save (⌘/Ctrl+S), the reason Save waits for (a text past its limit), and under it the
 * stale-save banner with Compare and merge, a refused save's reason, and the unsaved-changes dialog.
 *
 * @module components/Document/surface/SaveBar
 */
import clsx from 'clsx'
import { Loader2, Save, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import { ConflictBanner } from '../conflict/ConflictBanner'
import MergeDialog from '../conflict/MergeDialog'
import type { TFunction } from 'i18next'
import type { DocumentDraftState } from '../draft/useDocumentDraft'
import type { DraftEditor, StoredDocument } from '../types'

interface SaveBarProps<S extends StoredDocument, H extends DraftEditor> {
  readonly state: DocumentDraftState<S, H>
  /** Why Save waits (a text past its limit), said beside it; null: it does not. */
  readonly blocked: string | null
}

function statusOf<S extends StoredDocument, H extends DraftEditor>(state: DocumentDraftState<S, H>, t: TFunction<'documents'>): string {
  if (state.saving) return t('actions.status.saving')
  if (state.dirty) return t('actions.status.unsaved')
  return state.lastSaved === null ? '' : t('save.saved')
}

export default function SaveBar<S extends StoredDocument, H extends DraftEditor>({ state, blocked }: SaveBarProps<S, H>) {
  const { t } = useTranslation('documents')
  const idle = !state.dirty || state.saving
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" aria-live="polite" className={clsx('mr-auto min-w-0 text-[13px]', state.dirty ? 'text-warn' : 'text-muted')}>
          {statusOf(state, t)}
        </p>
        {blocked === null ? null : <p className="text-[12px] text-danger">{blocked}</p>}
        <button type="button" className="btn btn-secondary btn-sm" disabled={idle} onClick={state.discard}>
          <Undo2 size={14} aria-hidden="true" />{t('actions.discard')}
        </button>
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={idle || blocked !== null}
          aria-keyshortcuts="Control+S Meta+S"
          onClick={() => { if (!idle && blocked === null) saveIgnoringFailure(state.save) }}>
          {state.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          {state.saving ? t('actions.status.saving') : t('actions.save')}
        </button>
      </div>
      {state.conflict === null ? null : <ConflictBanner conflict={state.conflict} />}
      {state.merge.proposal === null ? null : (
        <MergeDialog changes={state.merge.proposal.changes} onTake={state.merge.take} onClose={state.merge.close} />
      )}
      {state.refused === null ? null : (
        <p role="alert" className="rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
          {state.refused.message ?? t('save.refused')}
        </p>
      )}
      {state.guardDialog}
    </div>
  )
}
