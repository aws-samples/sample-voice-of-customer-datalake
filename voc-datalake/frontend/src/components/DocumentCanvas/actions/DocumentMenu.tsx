/**
 * @fileoverview The document page's "Document" menu, the first of its menu bar (a WAI-ARIA menu button: arrow keys,
 * Home / End, Escape, focus back on the button; menuBar.ts): Save (with its state: Saved / Saving… / Unsaved changes;
 * inert while there is nothing to save), Rename (a research / custom document: focus on its title, selected), Share
 * (the review link of a PR/FAQ or PRD), then every export of the saved version (DocumentExportMenu: copy, Markdown,
 * PDF with "Include open comments", TXT, Copy to Kiro), then History and Delete.
 *
 * It is the document export menu with the page's items around the exports, so the exports stay one implementation.
 * A viewer gets the exports and History only; a decision (edited in its own tab) no Save and no History. Share and
 * History open the bar's dialogs (`DocumentDialogs`), which its toolbar opens too.
 *
 * @module components/DocumentCanvas/actions/DocumentMenu
 */
import clsx from 'clsx'
import { History, Loader2, PenLine, Save, Share2, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../DialogClose/DialogClose'
import DocumentExportMenu from '../../DocumentExportMenu/DocumentExportMenu'
import ModalShell from '../../ModalShell/ModalShell'
import { historyOffered, shareOffered } from './documentOffers'
import DocumentVersions from '../../../pages/ProjectDetail/DocumentVersions'
import ShareForReviewDialog from '../../../pages/ProjectDetail/ShareForReviewDialog'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import type { CanvasDocument } from './useCanvasDocument'
import type { ShareSettings } from '../../../api/documentReviewApi'
import type { CommentThread, ReviewShare } from '../../../api/documentReviewSchema'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'

/** The review link's state and its two writes (the comments hook's own fields: pass it as is). */
export interface DocumentShareControls {
  readonly share: ReviewShare | null
  readonly createShare: (settings: ShareSettings) => Promise<unknown>
  readonly revokeShare: () => Promise<unknown>
}

export interface DocumentMenuProps {
  readonly project: Project
  readonly document: ProjectDocument
  readonly canEdit: boolean
  readonly state: CanvasDocument
  /** Null for a document type without comments (only a PR/FAQ or PRD has a review link), or while they load. */
  readonly share: DocumentShareControls | null
  /** The document's comment threads, for "Include open comments"; null without comments. */
  readonly threads: readonly CommentThread[] | null
  readonly onDeleteDoc: () => void
  readonly isDeleting: boolean
  /** Rename: the page puts focus on the title, selected (offered while the title is editable). */
  readonly onRename?: () => void
}

/** The bar's dialogs: the review link's and History. */
export type DocumentDialog = 'share' | 'history'

const ITEM_CLASS = 'menu-item py-2.5 sm:py-1.5 active:bg-bg-hover'

function SaveItem({ state, close }: Readonly<{ state: CanvasDocument; close: () => void }>) {
  const { t } = useTranslation('projectDetail')
  const stateId = useId()
  const idle = !state.dirty || state.saving
  const label = (() => {
    if (state.saving) return t('documents:actions.status.saving')
    return state.dirty ? t('documents:actions.status.unsaved') : t('documents:menu.saved')
  })()
  return (
    // Not `disabled`: a disabled item could not take the menu's roving focus (APG: disabled items stay focusable).
    <button type="button" role="menuitem" aria-disabled={idle} aria-describedby={stateId} aria-keyshortcuts="Control+S Meta+S"
      className={clsx(ITEM_CLASS, idle && 'text-muted')}
      onClick={() => {
        if (idle) return
        close()
        saveIgnoringFailure(state.save)
      }}>
      {state.saving ? <Loader2 size={16} className="flex-shrink-0 animate-spin" aria-hidden="true" /> : <Save size={16} className="flex-shrink-0" aria-hidden="true" />}
      <span className="truncate">{t('documents:actions.save')}</span>
      {/* Its description, not part of its name: the item is "Save" whatever the state. */}
      <span id={stateId} aria-hidden="true" className={clsx('ml-auto pl-2 text-xs whitespace-nowrap', state.dirty ? 'text-warn' : 'text-muted')}>{label}</span>
    </button>
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

/** The dialog the bar has open (from the Document menu or the toolbar), or nothing. */
export function DocumentDialogs({ dialog, project, document, canEdit, state, share, onClose }: Readonly<{
  dialog: DocumentDialog | null; project: Project; document: ProjectDocument; canEdit: boolean; state: CanvasDocument
  share: DocumentShareControls | null; onClose: () => void
}>) {
  if (dialog === 'share' && share !== null) {
    return <ShareForReviewDialog share={share.share} onCreate={share.createShare} onRevoke={share.revokeShare} onClose={onClose} />
  }
  if (dialog === 'history') {
    return <HistoryDialog project={project} document={document} canEdit={canEdit} state={state} onClose={onClose} />
  }
  return null
}

export default function DocumentMenu({
  project, document, canEdit, state, share, threads, onDeleteDoc, isDeleting, onRename, onOpenDialog,
}: DocumentMenuProps & { readonly onOpenDialog: (dialog: DocumentDialog) => void }) {
  const { t } = useTranslation('projectDetail')
  const { t: tComponents } = useTranslation('components')
  const hintId = useId()
  const offeredShare = shareOffered(canEdit, share)
  const showHistory = historyOffered(document)
  /** Close the menu (focus back on its button), then run `action`: a dialog opened from it returns focus there. */
  const then = (close: () => void, action: () => void) => () => {
    close()
    action()
  }
  return (
    <DocumentExportMenu document={document} project={project} threads={threads} triggerLabel={t('documents:menu.trigger')}
      menuBar exportDescribedBy={state.dirty ? hintId : undefined}
      leading={({ close }) => (
        <>
          {state.editable ? <SaveItem state={state} close={close} /> : null}
          {state.editable && state.titleEditable && onRename !== undefined ? (
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={then(close, onRename)}>
              <PenLine size={16} className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{t('documents:menu.rename')}</span>
            </button>
          ) : null}
          {offeredShare === null ? null : (
            <button type="button" role="menuitem" aria-haspopup="dialog" className={ITEM_CLASS}
              onClick={then(close, () => onOpenDialog('share'))}>
              <Share2 size={16} className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{offeredShare.share === null ? tComponents('reviewShare.open') : tComponents('reviewShare.openActive')}</span>
            </button>
          )}
          {state.editable || offeredShare !== null ? <hr className="menu-separator border-0" /> : null}
          {/* Export reads the stored version (what the link, the review page and the assistant read). */}
          {state.dirty ? (
            <p id={hintId} role="presentation" className="px-3 py-1.5 text-xs text-warn">{t('documents:actions.exportSavedHint')}</p>
          ) : null}
        </>
      )}>
      {({ close }) => showHistory || canEdit ? (
        <>
          <hr className="menu-separator border-0" />
          {showHistory ? (
            <button type="button" role="menuitem" aria-haspopup="dialog" className={ITEM_CLASS}
              onClick={then(close, () => onOpenDialog('history'))}>
              <History size={16} className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{t('documents:actions.history')}</span>
            </button>
          ) : null}
          {canEdit ? (
            // The page asks first (its confirm dialog).
            <button type="button" role="menuitem" aria-disabled={isDeleting} className={clsx(ITEM_CLASS, 'text-danger')}
              onClick={isDeleting ? undefined : then(close, onDeleteDoc)}>
              {isDeleting ? <Loader2 size={16} className="flex-shrink-0 animate-spin" aria-hidden="true" /> : <Trash2 size={16} className="flex-shrink-0" aria-hidden="true" />}
              <span className="truncate">{t('documents.deleteDocument')}</span>
            </button>
          ) : null}
        </>
      ) : null}
    </DocumentExportMenu>
  )
}
