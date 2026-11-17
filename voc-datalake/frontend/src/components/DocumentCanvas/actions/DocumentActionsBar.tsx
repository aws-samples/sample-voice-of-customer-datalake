/**
 * @fileoverview The document page's top bar, an editing canvas's: its menu bar (Document · Edit · Format · Insert ·
 * View; menuBar.ts), the save status, Discard and Save, then the icon toolbar (DocumentToolbar: the version picker,
 * History, AI review, AI rewrite, Comments, Contents, Full width, Full screen, Share); the stale-save conflict under it.
 *
 * Document is DocumentMenu (Save, Rename, Share, every export, History, Delete); Edit, Format and Insert are the
 * editor's own actions (canvasMenus.ts), offered on an editable canvas only (not while an older version is on screen);
 * View switches the comments panel, the outline, the width and full screen, which the toolbar switches too (one state,
 * two doors). Share and History are one dialog each, whichever door opens it (`DocumentDialogs`). A viewer sees
 * Document (the exports and History only: every other control would 403), View, the status and the toolbar without
 * Share and the AI flows. Export always exports the SAVED version (what the link, the review page and the assistant
 * read); while the canvas holds unsaved changes the menu says so. On a phone the bar wraps, and while there is
 * something to save, Discard and Save sit in a bar fixed to the bottom of the screen, registered as the bottom safe
 * area (components/StickyActionBar/actionBarRegistry) so the assistant launcher lifts above it.
 *
 * @module components/DocumentCanvas/actions/DocumentActionsBar
 */
import clsx from 'clsx'
import { Loader2, Save, Undo2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../../../hooks/useNow'
import { useRegisterActionBar } from '../../StickyActionBar/actionBarRegistry'
import { isVersionManagedDocument } from '../../../api/documentLineage'
import { ConflictBanner, ReviseRefusedBanner } from './ConflictBanner'
import DocumentMenu, { DocumentDialogs } from './DocumentMenu'
import { historyOffered, shareOffered } from './documentOffers'
import DocumentToolbar from './DocumentToolbar'
import CanvasMenu from './CanvasMenu'
import { editEntries, formatEntries, insertEntries, viewEntries, type CanvasViewControls } from './canvasMenus'
import { onMenuBarKeyDown } from './menuBar'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import { formatRelativeDate } from '../../../utils/dateUtils'
import type { DocumentDialog, DocumentMenuProps } from './DocumentMenu'
import type { CanvasDocument } from './useCanvasDocument'
import type { ReviewActions } from './toolbarItems'
import type { VersionChoice } from './versionChoices'
import type { FocusViewControls } from '../page/useFocusView'
import type { ProjectDocument } from '../../../api/types'

interface DocumentActionsBarProps extends DocumentMenuProps {
  /** The page's focus view ("Full screen"). */
  readonly focus: FocusViewControls
  /** The "Full screen" button: the page puts focus back on it when the focus view closes. */
  readonly focusButtonRef: RefObject<HTMLButtonElement | null>
  /** What View switches (absent: no View menu, as in a spec of the bar alone). */
  readonly view?: CanvasViewControls
  /** The open comment threads, for the Comments button (absent: the document has no comments panel). */
  readonly openThreads?: number
  /** The number of the older version on screen (`/v/<n>`), null: the document's own. */
  readonly viewing: number | null
  /** A version chosen in the toolbar's picker. */
  readonly onChooseVersion: (choice: VersionChoice) => void
  /** The AI flows of a PR/FAQ or PRD, for whoever may run them (else null). */
  readonly review: ReviewActions | null
}

/** The stored version's number: a PRD / PR/FAQ series version, or a research / custom edit count. */
function versionNumber(document: ProjectDocument): number | undefined {
  return isVersionManagedDocument(document) ? document.version : (document.revision ?? 1)
}

function SaveStatus({ document, state }: Readonly<{ document: ProjectDocument; state: CanvasDocument }>) {
  const { t, i18n } = useTranslation('projectDetail')
  const now = useNow()
  const text = (() => {
    if (state.saving) return t('documents:actions.status.saving')
    if (state.dirty) return t('documents:actions.status.unsaved')
    const when = formatRelativeDate(document.updated_at ?? document.created_at, i18n.language, now)
    const n = versionNumber(document)
    return n === undefined
      ? t('documents:actions.status.savedNoVersion', { when })
      : t('documents:actions.status.saved', { version: t('documents.versions.label', { n }), when })
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
        title={t('documents:actions.discardHint')}>
        <Undo2 size={14} aria-hidden="true" />{t('documents:actions.discard')}
      </button>
      <button type="button" className="btn btn-primary btn-sm" disabled={idle} aria-keyshortcuts="Control+S Meta+S"
        title={t('documents:actions.saveHint')} onClick={() => saveIgnoringFailure(state.save)}>
        {state.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
        {state.saving ? t('documents:actions.status.saving') : t('documents:actions.save')}
      </button>
    </div>
  )
}

/** Document, then (an editable canvas) Edit, Format and Insert, then View: one row of menus the arrow keys walk. */
function MenuBar({ menu, focus, view, editing, onOpenDialog }: Readonly<{
  menu: DocumentMenuProps; focus: FocusViewControls; view?: CanvasViewControls; editing: boolean
  onOpenDialog: (dialog: DocumentDialog) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const { state } = menu
  const handle = () => state.handleRef.current
  const fullScreen = { on: focus.active, toggle: focus.toggle }
  return (
    <div role="group" aria-label={t('documents:menubar.label')} data-testid="document-menubar" onKeyDown={onMenuBarKeyDown}
      className="flex flex-wrap items-center gap-0.5">
      <DocumentMenu {...menu} onOpenDialog={onOpenDialog} />
      {editing ? (
        <>
          <CanvasMenu label={t('documents:menubar.edit')} entries={() => editEntries(handle, t)} />
          <CanvasMenu label={t('documents:menubar.format')} entries={() => formatEntries(handle, t)} />
          <CanvasMenu label={t('documents:menubar.insert')} entries={() => insertEntries(handle, t)} />
        </>
      ) : null}
      {view === undefined ? null : <CanvasMenu label={t('documents:menubar.view')} entries={() => viewEntries(view, fullScreen, t)} />}
    </div>
  )
}

export default function DocumentActionsBar({
  focus, focusButtonRef, view, openThreads, viewing, onChooseVersion, review, ...menu
}: DocumentActionsBarProps) {
  const { t } = useTranslation('projectDetail')
  const { project, document, canEdit, state, share } = menu
  const [dialog, setDialog] = useState<DocumentDialog | null>(null)
  const offeredShare = shareOffered(canEdit, share)
  // The editor's own menus write the text: not while an older version is on screen (the text is not in view).
  const editing = state.editable && viewing === null
  return (
    <div className="space-y-2">
      <div role="group" aria-label={t('documents:actions.toolbarLabel')} data-testid="document-actions-bar"
        className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <MenuBar menu={menu} focus={focus} view={view} editing={editing} onOpenDialog={setDialog} />
        <SaveStatus document={document} state={state} />
        {/* One group at the row's end: on a phone it wraps under the status as a whole. */}
        <div data-testid="document-actions-controls" className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* The canvas's own rule: an editor of the project, a document edited on its canvas. */}
          {state.editable ? <SaveButtons state={state} /> : null}
          <DocumentToolbar view={view} openThreads={openThreads} focus={{ on: focus.active, toggle: focus.toggle }}
            focusButtonRef={focusButtonRef} onHistory={() => setDialog('history')} review={review}
            versions={historyOffered(document) ? { projectId: project.project_id, document, viewing, onChoose: onChooseVersion } : null}
            share={offeredShare === null ? null : { active: offeredShare.share !== null, onOpen: () => setDialog('share') }} />
        </div>
      </div>
      {state.conflict === null ? null : <ConflictBanner conflict={state.conflict} />}
      {state.reviseRefused === null ? null : <ReviseRefusedBanner refused={state.reviseRefused} />}
      {state.guardDialog}
      <DocumentDialogs dialog={dialog} project={project} document={document} canEdit={canEdit} state={state}
        share={offeredShare} onClose={() => setDialog(null)} />
    </div>
  )
}
