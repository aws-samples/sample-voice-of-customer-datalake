/**
 * @fileoverview The document page's action bar: the save status, Discard and Save, "Full screen" (the focus view) and
 * the "File" menu (DocumentMenu: Save, Share, every export, History, Delete), then the stale-save conflict.
 *
 * A viewer sees the status, Full screen and the menu with the exports and History only: every other control would
 * 403. Export always exports the SAVED version (what the link, the review page and the assistant read); while the
 * canvas holds unsaved changes the menu says so. On a phone the bar wraps, and while there is something to save,
 * Discard and Save sit in a bar fixed to the bottom of the screen, registered as the bottom safe area
 * (components/StickyActionBar/actionBarRegistry) so the assistant launcher lifts above it.
 *
 * @module components/DocumentCanvas/actions/DocumentActionsBar
 */
import clsx from 'clsx'
import { Loader2, Maximize2, Minimize2, Save, Undo2 } from 'lucide-react'
import { useRef } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../../../hooks/useNow'
import { useRegisterActionBar } from '../../StickyActionBar/actionBarRegistry'
import { isVersionManagedDocument } from '../../../api/documentLineage'
import { ConflictBanner } from './ConflictBanner'
import DocumentMenu from './DocumentMenu'
import { saveIgnoringFailure } from '../../UnsavedChangesGuard/useSnapshotGuard'
import { formatRelativeDate } from '../../../utils/dateUtils'
import type { DocumentMenuProps } from './DocumentMenu'
import type { CanvasDocument } from './useCanvasDocument'
import type { FocusViewControls } from '../page/useFocusView'
import type { ProjectDocument } from '../../../api/types'

interface DocumentActionsBarProps extends DocumentMenuProps {
  /** The page's focus view ("Full screen"). */
  readonly focus: FocusViewControls
  /** The "Full screen" button: the page puts focus back on it when the focus view closes. */
  readonly focusButtonRef: RefObject<HTMLButtonElement | null>
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

/** "Full screen": a toggle button (its name stays, `aria-pressed` says whether the focus view is on). */
function FocusButton({ active, onToggle, buttonRef }: Readonly<{
  active: boolean; onToggle: () => void; buttonRef: RefObject<HTMLButtonElement | null>
}>) {
  const { t } = useTranslation('projectDetail')
  const Icon = active ? Minimize2 : Maximize2
  return (
    <button ref={buttonRef} type="button" className="icon-btn p-2 rounded-lg" aria-pressed={active}
      aria-label={t('canvas.focus.button')} title={t('canvas.focus.hint')} aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
      onClick={onToggle} data-testid="canvas-focus-button">
      <Icon size={16} aria-hidden="true" />
    </button>
  )
}

export default function DocumentActionsBar({ focus, focusButtonRef, ...menu }: DocumentActionsBarProps) {
  const { t } = useTranslation('projectDetail')
  const { document, state } = menu
  return (
    <div className="space-y-2">
      <div role="group" aria-label={t('canvas.actions.toolbarLabel')} data-testid="document-actions-bar"
        className="flex flex-wrap items-center gap-2">
        <SaveStatus document={document} state={state} />
        {/* One group at the row's end: on a phone it wraps under the status as a whole, so "File" stays at the right
            edge and its menu (right-aligned to it) opens inside the screen, never past its left edge. */}
        <div data-testid="document-actions-controls" className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* The canvas's own rule: an editor of the project, a document edited on its canvas. */}
          {state.editable ? <SaveButtons state={state} /> : null}
          <FocusButton active={focus.active} onToggle={focus.toggle} buttonRef={focusButtonRef} />
          <DocumentMenu {...menu} />
        </div>
      </div>
      {state.conflict === null ? null : <ConflictBanner conflict={state.conflict} />}
      {state.guardDialog}
    </div>
  )
}
