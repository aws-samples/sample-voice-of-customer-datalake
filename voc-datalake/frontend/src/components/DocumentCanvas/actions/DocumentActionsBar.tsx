/**
 * @fileoverview The document page's action bar: the save status, Discard and Save,
 * Share (PR/FAQ and PRD), Export, History and Delete, then the stale-save conflict.
 *
 * A viewer sees the status, Export and History only: every other control would 403.
 * Export always exports the SAVED version (what the link, the review page and the
 * assistant read); while the canvas holds unsaved changes the menu says so. On a
 * phone the bar wraps, and while there is something to save, Discard and Save sit in
 * a bar fixed to the bottom of the screen, registered as the bottom safe area
 * (components/StickyActionBar/actionBarRegistry) so the assistant launcher lifts above it.
 *
 * @module components/DocumentCanvas/actions/DocumentActionsBar
 */
import clsx from 'clsx'
import { History, Loader2, Save, Share2, Undo2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../../../hooks/useNow'
import DialogClose from '../../DialogClose/DialogClose'
import DocumentExportMenu from '../../DocumentExportMenu/DocumentExportMenu'
import ModalShell from '../../ModalShell/ModalShell'
import { useRegisterActionBar } from '../../StickyActionBar/actionBarRegistry'
import { isVersionManagedDocument } from '../../../api/documentLineage'
import { ConflictBanner } from './ConflictBanner'
import DeleteDocumentButton from './DeleteDocumentButton'
import { isEditedElsewhere } from './documentKinds'
import DocumentVersions from '../../../pages/ProjectDetail/DocumentVersions'
import ShareForReviewDialog from '../../../pages/ProjectDetail/ShareForReviewDialog'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import { formatRelativeDate } from '../../../utils/dateUtils'
import type { CanvasDocument } from './useCanvasDocument'
import type { ShareSettings } from '../../../api/documentReviewApi'
import type { ReviewShare } from '../../../api/documentReviewSchema'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'

/** The review link's state and its two writes (the comments hook's own fields: pass it as is). */
interface DocumentShareControls {
  readonly share: ReviewShare | null
  readonly createShare: (settings: ShareSettings) => Promise<unknown>
  readonly revokeShare: () => Promise<unknown>
}

interface DocumentActionsBarProps {
  readonly project: Project
  readonly document: ProjectDocument
  readonly canEdit: boolean
  readonly state: CanvasDocument
  /** Null for a document type without comments (only a PR/FAQ or PRD has a review link), or while they load. */
  readonly share: DocumentShareControls | null
  readonly onDeleteDoc: () => void
  readonly isDeleting: boolean
}

/** The stored version's number: a PRD / PR/FAQ series version, or a research / custom edit count. */
function versionNumber(document: ProjectDocument): number | undefined {
  return isVersionManagedDocument(document) ? document.version : (document.revision ?? 1)
}

function SaveStatus({ document, state }: Readonly<{ document: ProjectDocument; state: CanvasDocument }>) {
  const { t, i18n } = useTranslation('projectDetail')
  const now = useNow()
  const text = (() => {
    if (state.saving) return t('canvas.actions.status.saving')
    if (state.dirty) return t('canvas.actions.status.unsaved')
    const when = formatRelativeDate(document.updated_at ?? document.created_at, i18n.language, now)
    const n = versionNumber(document)
    return n === undefined
      ? t('canvas.actions.status.savedNoVersion', { when })
      : t('canvas.actions.status.saved', { version: t('documents.versions.label', { n }), when })
  })()
  return (
    <p role="status" aria-live="polite" data-testid="canvas-save-status"
      className={clsx('mr-auto min-w-0 text-[13px]', state.dirty ? 'text-warn' : 'text-muted')}>
      {text}
    </p>
  )
}

function SaveButtons({ state }: Readonly<{ state: CanvasDocument }>) {
  const { t } = useTranslation('projectDetail')
  const idle = !state.dirty || state.saving
  // Registered like a StickyActionBar: the floating assistant launcher lifts above it instead of covering Save.
  const ref = useRef<HTMLDivElement>(null)
  useRegisterActionBar(ref)
  return (
    <div ref={ref} data-action-bar="" className={clsx('flex items-center gap-2',
      // A phone: what there is to save stays in reach at the bottom of the screen.
      state.dirty && 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30 max-sm:justify-end max-sm:border-t max-sm:border-border max-sm:bg-card max-sm:p-3')}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={idle} onClick={state.discard}
        title={t('canvas.actions.discardHint')}>
        <Undo2 size={14} aria-hidden="true" />{t('canvas.actions.discard')}
      </button>
      <button type="button" className="btn btn-primary btn-sm" disabled={idle} aria-keyshortcuts="Control+S Meta+S"
        title={t('canvas.actions.saveHint')} onClick={() => saveIgnoringFailure(state.save)}>
        {state.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
        {state.saving ? t('canvas.actions.status.saving') : t('canvas.actions.save')}
      </button>
    </div>
  )
}

function ExportSaved({ project, document, dirty }: Readonly<{ project: Project; document: ProjectDocument; dirty: boolean }>) {
  const { t } = useTranslation('projectDetail')
  const hintId = useId()
  if (!dirty) return <DocumentExportMenu document={document} project={project} />
  return (
    <span title={t('canvas.actions.exportSavedHint')} aria-describedby={hintId} className="inline-flex">
      <DocumentExportMenu document={document} project={project} />
      <span id={hintId} className="sr-only">{t('canvas.actions.exportSavedHint')}</span>
    </span>
  )
}

function HistoryDialog({ project, document, canEdit, state, onClose }: Readonly<{
  project: Project; document: ProjectDocument; canEdit: boolean; state: CanvasDocument; onClose: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const headingId = useId()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={headingId} panelClassName="w-full max-w-2xl">
      <div className="dialog-header justify-between">
        <h2 id={headingId} className="dialog-title">{t('documents.versions.title')}</h2>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body max-h-[70vh] space-y-2 overflow-y-auto">
        <p className="text-[12px] text-muted">{t('documents.versions.hint')}</p>
        <DocumentVersions key={document.document_id} projectId={project.project_id} document={document} canEdit={canEdit}
          // A restore is a new version: close, and let the canvas reload on it.
          onSelectDoc={(restored) => { onClose(); state.selectDoc(restored) }} />
      </div>
    </ModalShell>
  )
}

function ShareButton({ share }: Readonly<{ share: DocumentShareControls }>) {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Share2 size={14} aria-hidden="true" />{share.share === null ? t('reviewShare.open') : t('reviewShare.openActive')}
      </button>
      {open ? (
        <ShareForReviewDialog share={share.share} onCreate={share.createShare} onRevoke={share.revokeShare}
          onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

export default function DocumentActionsBar({
  project, document, canEdit, state, share, onDeleteDoc, isDeleting,
}: DocumentActionsBarProps) {
  const { t } = useTranslation('projectDetail')
  const [history, setHistory] = useState(false)
  return (
    <div className="space-y-2">
      <div role="group" aria-label={t('canvas.actions.toolbarLabel')} data-testid="document-actions-bar"
        className="flex flex-wrap items-center gap-2">
        <SaveStatus document={document} state={state} />
        {/* The canvas's own rule: an editor of the project, a document edited on its canvas. */}
        {state.editable ? <SaveButtons state={state} /> : null}
        {canEdit && share !== null ? <ShareButton share={share} /> : null}
        <ExportSaved project={project} document={document} dirty={state.dirty} />
        {isEditedElsewhere(document.document_type) ? null : (
          <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="dialog" onClick={() => setHistory(true)}>
            <History size={14} aria-hidden="true" />{t('canvas.actions.history')}
          </button>
        )}
        {canEdit ? <DeleteDocumentButton isDeleting={isDeleting} onDeleteDoc={onDeleteDoc} /> : null}
      </div>
      {state.conflict === null ? null : <ConflictBanner conflict={state.conflict} />}
      {history ? (
        <HistoryDialog project={project} document={document} canEdit={canEdit} state={state} onClose={() => setHistory(false)} />
      ) : null}
      {state.guardDialog}
    </div>
  )
}
