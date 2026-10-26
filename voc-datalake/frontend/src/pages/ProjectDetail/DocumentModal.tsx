/**
 * DocumentModal - Modal for creating/editing documents
 *
 * `ModalShell` supplies dialog semantics and the focus trap. It is not
 * dismissable by Escape or backdrop click (the old hand-rolled overlay had
 * neither): a stray click would discard a whole unsaved document. Labels are
 * tied to their controls so each field has an accessible name.
 */
import { AlertTriangle, Loader2, FileText, Pencil } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { saveIgnoringFailure, useSnapshotGuard } from '../../components/UnsavedChangesGuard/useSnapshotGuard'

/** The editor's own fields and callbacks, shared with the wrapper that decides when to show it. */
export interface DocumentEditorProps {
  readonly title: string
  readonly content: string
  readonly isSaving: boolean
  readonly onTitleChange: (title: string) => void
  readonly onContentChange: (content: string) => void
  /** Resolves once saved, rejects on failure (the unsaved-changes guard waits for it). */
  readonly onSave: () => Promise<unknown>
  readonly onClose: () => void
  /** Someone saved the document after this editor loaded it (409): reload, or save over it. */
  readonly conflict?: DocumentConflict | null
}

export interface DocumentConflict {
  readonly onLoadLatest: () => Promise<unknown>
  readonly onSaveAnyway: () => Promise<unknown>
}

/** The stale-save banner: what happened, and the two ways out (same pattern as the workflow editor). */
function ConflictBanner({ conflict }: Readonly<{ conflict: DocumentConflict }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
      <span className="mr-auto">{t('documentModal.conflict')}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void conflict.onLoadLatest()}>{t('documentModal.conflictReload')}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => saveIgnoringFailure(conflict.onSaveAnyway)}>{t('documentModal.conflictSaveAnyway')}</button>
    </div>
  )
}

interface DocumentModalProps extends DocumentEditorProps {
  readonly isEditing: boolean
  readonly titleReadOnly?: boolean
}

export default function DocumentModal({
  isEditing,
  title,
  titleReadOnly = false,
  content,
  isSaving,
  onTitleChange,
  onContentChange,
  onSave,
  onClose,
  conflict = null,
}: DocumentModalProps) {
  const isValid = title.trim() !== '' && content.trim() !== ''
  const { t } = useTranslation('projectDetail')
  const headingId = useId()
  const titleId = useId()
  const contentId = useId()
  const previewId = useId()
  // Every exit (the X, Cancel, Escape, the backdrop) asks first when the text changed (E2E F6).
  const { close, dialog: guardDialog } = useSnapshotGuard({ value: { title, content }, onSave, onClose, canSave: isValid })

  return (
    <ModalShell
      isOpen
      onClose={close}
      ariaLabelledBy={headingId}
      panelClassName="max-w-3xl max-h-[90vh]"
      // Escape/backdrop go through the unsaved-changes guard, so typed work is
      // never dropped silently; off only while a save is in flight.
      dismissable={!isSaving}
    >
      <div className="dialog-header justify-between">
        <h2 id={headingId} className="dialog-title">{isEditing ? t('documentModal.editDocument') : t('documentModal.createDocument')}</h2>
        <DialogClose onClick={close} />
      </div>
      <div className="dialog-body space-y-4">
        {conflict === null ? null : <ConflictBanner conflict={conflict} />}
        <div>
          <label htmlFor={titleId} className="block text-sm font-medium text-text mb-1">{t('documentModal.titleLabel')}</label>
          <input
            id={titleId}
            type="text"
            value={title}
            disabled={titleReadOnly}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={t('documentModal.titlePlaceholder')}
            className="input disabled:bg-bg-hover disabled:text-text"
          />
        </div>
        <div>
          <label htmlFor={contentId} className="block text-sm font-medium text-text mb-1">{t('documentModal.contentLabel')}</label>
          <textarea
            id={contentId}
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder={t('documentModal.contentPlaceholder')}
            rows={12}
            className="input font-mono text-sm"
          />
        </div>
        {content === '' ? null : <div>
          {/* A caption, not a <label>: the preview is not a form control. */}
          <p id={previewId} className="block text-sm font-medium text-text mb-1">{t('documentModal.preview')}</p>
          <div aria-labelledby={previewId} role="region" tabIndex={0} className="border border-border rounded-lg p-4 md-content bg-bg-accent max-h-48 overflow-y-auto focus-ring">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>}
      </div>
      <div className="dialog-footer flex-col-reverse sm:flex-row">
        <button type="button" onClick={close} className="btn btn-secondary w-full sm:w-auto">{t('documentModal.cancel')}</button>
        <button
          type="button"
          onClick={() => saveIgnoringFailure(onSave)}
          disabled={!isValid || isSaving}
          className="btn btn-primary w-full sm:w-auto"
        >
          {isSaving ? (
            <><Loader2 size={16} className="animate-spin" aria-hidden />{isEditing ? t('documentModal.saving') : t('documentModal.creating')}</>
          ) : (
            <>{isEditing ? <Pencil size={16} aria-hidden /> : <FileText size={16} aria-hidden />}{isEditing ? t('documentModal.saveChanges') : t('documentModal.create')}</>
          )}
        </button>
      </div>
      {guardDialog}
    </ModalShell>
  )
}
