/**
 * @fileoverview The builder's Save, Publish and Update live form (UX §3.1's table, R10: two buttons at most):
 *
 * | State | Secondary | Primary |
 * |---|---|---|
 * | Off, no edits | — | Publish |
 * | Off (or new), with edits | Save | Publish (saves, then turns the form Live) |
 * | Live, no edits | — | — |
 * | Live, with edits | — | Update live form |
 *
 * With errors both are `aria-disabled` with the reason in a Tooltip (the status line says it in words too).
 * ⌘/Ctrl+S saves, or updates the live form. Publishing an AI draft nobody has saved asks first (UX §12.3);
 * updating a live form that removes something with answers lists it first (UX §3.6).
 *
 * @module pages/FeedbackForms/builder/SaveButtons
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Radio, Save } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { useDraft } from './formDraftContext'
import { removedParts } from './draftChanges'
import { noCleanup } from '../../../hooks/noCleanup'

type Pending = { readonly kind: 'aiPublish' } | { readonly kind: 'removal'; readonly list: string } | null

function useBuilderSaveKey(onSave: (() => void) | null): void {
  useEffect(() => {
    if (onSave === null) return noCleanup
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      onSave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])
}

/** What the buttons do: Save, Publish (an unsaved AI draft asks first), Update live form (a removal asks first). */
function useSaveActions() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const [pending, setPending] = useState<Pending>(null)
  const live = draft.form.enabled && !draft.isNew
  const ready = draft.errors.length === 0 && draft.status.kind !== 'saving'
  const update = () => {
    const list = draft.baseline !== null && draft.locked ? removedParts(t, draft.baseline, draft.form) : []
    if (list.length > 0) setPending({ kind: 'removal', list: list.join(', ') })
    else saveIgnoringFailure(draft.save)
  }
  const publish = () => {
    if (draft.ai?.kind === 'draft' && draft.isNew) setPending({ kind: 'aiPublish' })
    else saveIgnoringFailure(draft.publish)
  }
  const save = () => saveIgnoringFailure(draft.save)
  const confirm = () => {
    setPending(null)
    saveIgnoringFailure(pending?.kind === 'aiPublish' ? draft.publish : draft.save)
  }
  return {
    showSave: !live && draft.dirty,
    showPrimary: !live || draft.dirty,
    primaryLabel: live ? t('builder.save.update') : t('builder.save.publish'),
    onPrimary: live ? update : publish,
    busy: draft.status.kind === 'saving',
    reason: draft.errors.length > 0 ? t('builder.save.fixToSave', { count: draft.errors.length }) : undefined,
    pendingKind: pending?.kind ?? null,
    removalList: pending?.kind === 'removal' ? pending.list : '',
    save, confirm,
    cancel: () => setPending(null),
    shortcut: () => { if (draft.dirty && ready) (live ? update : save)() },
  }
}

/** One of the two buttons: `aria-disabled` with the reason while errors block it (UX §3.1). */
function SaveButton({ primary, label, busy, reason, onClick }: Readonly<{
  primary: boolean; label: string; busy: boolean; reason: string | undefined; onClick: () => void
}>) {
  const off = reason !== undefined || busy
  const icon = busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />
  return (
    <Tooltip kind="description" content={reason}>
      <button type="button" className={primary ? 'btn btn-primary' : 'btn btn-secondary'} aria-disabled={off}
        onClick={() => { if (!off) onClick() }}>
        {primary ? <Radio size={16} aria-hidden="true" /> : icon}
        {label}
      </button>
    </Tooltip>
  )
}

export default function SaveButtons({ withShortcut = false }: Readonly<{ withShortcut?: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const actions = useSaveActions()
  useBuilderSaveKey(withShortcut ? actions.shortcut : null)
  const { busy, reason } = actions
  return (
    <div className="flex items-center gap-2">
      {actions.showSave && <SaveButton primary={false} label={t('builder.save.save')} busy={busy} reason={reason} onClick={actions.save} />}
      {actions.showPrimary && <SaveButton primary label={actions.primaryLabel} busy={busy} reason={reason} onClick={actions.onPrimary} />}
      <ConfirmModal isOpen={actions.pendingKind === 'aiPublish'} title={t('builder.confirmAiPublish.title')}
        message={t('builder.confirmAiPublish.message')} confirmLabel={t('builder.confirmAiPublish.confirm')} variant="warning"
        onConfirm={actions.confirm} onCancel={actions.cancel} />
      <ConfirmModal isOpen={actions.pendingKind === 'removal'} title={t('builder.confirmRemoval.title')}
        message={t('builder.confirmRemoval.message', { list: actions.removalList })}
        confirmLabel={t('builder.confirmRemoval.confirm')} variant="warning" onConfirm={actions.confirm} onCancel={actions.cancel} />
    </div>
  )
}
