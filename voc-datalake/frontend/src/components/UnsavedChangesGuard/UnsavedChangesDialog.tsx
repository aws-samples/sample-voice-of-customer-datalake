/**
 * @fileoverview "Unsaved changes" — Save / Discard / Cancel (E2E F6).
 *
 * The one dialog every editor's guard opens (`useUnsavedChangesGuard`), so it
 * has the same accessible name everywhere. Built on ModalShell: focus moves in
 * (to Cancel, the safe choice) and is trapped, Escape and the backdrop mean
 * Cancel, and it stacks over an editor dialog — Escape closes only this one.
 * Not dismissable while a save is in flight.
 *
 * @module components/UnsavedChangesGuard/UnsavedChangesDialog
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Save } from 'lucide-react'
import ModalShell from '../ModalShell/ModalShell'

interface UnsavedChangesDialogProps {
  readonly isOpen: boolean
  readonly saving: boolean
  readonly saveFailed: boolean
  readonly canSave: boolean
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly onCancel: () => void
}

export default function UnsavedChangesDialog({
  isOpen, saving, saveFailed, canSave, onSave, onDiscard, onCancel,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation('components')
  const titleId = useId()
  return (
    <ModalShell isOpen={isOpen} onClose={onCancel} ariaLabelledBy={titleId} dismissable={!saving} panelClassName="max-w-md">
      <div className="dialog-body space-y-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-warn-subtle text-warn">
            <AlertTriangle size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title whitespace-normal">{t('unsavedChanges.title')}</h2>
            <p className="dialog-description mt-1 text-sm">{t('unsavedChanges.message')}</p>
          </div>
        </div>
        {!canSave && <p className="text-[12px] text-muted">{t('unsavedChanges.cannotSave')}</p>}
        {saveFailed && <p role="alert" className="text-[12px] text-danger">{t('unsavedChanges.saveFailed')}</p>}
      </div>
      <div className="dialog-footer flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          {t('unsavedChanges.cancel')}
        </button>
        <button type="button" className="btn btn-danger" onClick={onDiscard} disabled={saving}>
          {t('unsavedChanges.discard')}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving || !canSave}>
          {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          {t('unsavedChanges.save')}
        </button>
      </div>
    </ModalShell>
  )
}
