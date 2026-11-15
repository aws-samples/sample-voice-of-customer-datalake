/**
 * @fileoverview The confirmation of a workspace's delete: it says again, first, that the delete is permanent and
 * cannot be undone, and what goes (workspaceDeleteParts.tsx), with the way to the export. Delete is enabled only once
 * the workspace's slug is typed exactly, a reason is given (kept for good in the audit log, so no personal data:
 * the legal-basis rules, utils/legalBasis.ts) and "I understand" is ticked. The typed slug is sent as
 * `confirm_slug`, so the server checks it again; a refusal is said in words here, and the dialog stays open.
 *
 * A dialog of its own on ModalShell rather than ConfirmModal: its body scrolls, so the list, the fields and the
 * buttons all fit a small screen. The caller renders it only while open, so each opening starts with empty fields;
 * while the request is in flight it cannot be dismissed.
 *
 * @module pages/WorkspaceSettings/DeleteWorkspaceDialog
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import LegalBasisField from '../../components/LegalBasisField/LegalBasisField'
import ModalShell from '../../components/ModalShell/ModalShell'
import { isLegalBasis } from '../../utils/legalBasis'
import RefusalAlert from '../../workspace/RefusalAlert'
import { DELETE_REFUSALS } from '../../workspace/workspaceRefusals'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { DeletedContents, ExportFirst } from './workspaceDeleteParts'

interface DeleteWorkspaceDialogProps {
  readonly workspace: CurrentWorkspace
  readonly pending: boolean
  /** The last refusal, if any. */
  readonly error: unknown
  /** Called with the slug as typed (equal to the workspace's) and the reason, trimmed. */
  readonly onConfirm: (confirmSlug: string, reason: string) => void
  readonly onCancel: () => void
  readonly onShowExport: () => void
}

export default function DeleteWorkspaceDialog({ workspace, pending, error, onConfirm, onCancel, onShowExport }: DeleteWorkspaceDialogProps) {
  const { t } = useTranslation()
  const ids = { title: useId(), slug: useId(), understood: useId() }
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const [understood, setUnderstood] = useState(false)
  const confirmSlug = typed.trim()
  const ready = confirmSlug === workspace.slug && isLegalBasis(reason) && understood && !pending
  return (
    <ModalShell isOpen onClose={onCancel} ariaLabelledBy={ids.title} dismissable={!pending} panelClassName="w-full max-w-lg max-h-[90vh]">
      <div className="dialog-header">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertTriangle size={18} aria-hidden="true" />
        </div>
        <h2 id={ids.title} className="dialog-title">{t('workspaces.delete.dialogTitle', { name: workspace.name })}</h2>
      </div>
      <form className="contents" noValidate onSubmit={(event) => {
        event.preventDefault()
        if (ready) onConfirm(confirmSlug, reason.trim())
      }}>
        <div className="dialog-body space-y-4">
          <p className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm font-semibold text-danger">
            {t('workspaces.delete.permanentFor', { name: workspace.name })}
          </p>
          <DeletedContents />
          <ExportFirst onShowExport={onShowExport} />
          <div className="space-y-1">
            <label htmlFor={ids.slug} className="block text-sm font-medium text-text">{t('workspaces.delete.typeSlug', { slug: workspace.slug })}</label>
            <input id={ids.slug} className="input w-full font-mono" value={typed} autoComplete="off" spellCheck={false}
              autoCapitalize="none" disabled={pending} onChange={(event) => setTyped(event.target.value)} />
          </div>
          <LegalBasisField value={reason} onChange={setReason} disabled={pending} label={t('workspaces.delete.reasonLabel')}
            hint={t('workspaces.delete.reasonHint')} />
          <div className="flex items-start gap-2">
            <input id={ids.understood} type="checkbox" className="mt-0.5 accent-danger" checked={understood} disabled={pending}
              onChange={(event) => setUnderstood(event.target.checked)} />
            <label htmlFor={ids.understood} className="text-sm text-text">{t('workspaces.delete.understood')}</label>
          </div>
          <RefusalAlert error={error} refusals={DELETE_REFUSALS} />
        </div>
        <div className="dialog-footer flex-col-reverse sm:flex-row sm:gap-3">
          <button type="button" className="btn btn-secondary w-full sm:w-auto" disabled={pending} onClick={onCancel}>
            {t('common:cancel')}
          </button>
          <button type="submit" className="btn btn-danger-solid gap-2 w-full sm:w-auto" disabled={!ready}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
            {pending ? t('workspaces.delete.deleting') : t('workspaces.delete.confirm')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
