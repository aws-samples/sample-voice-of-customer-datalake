/**
 * @fileoverview The free-form workflow editor: palette · canvas · inspector, with a toolbar for Save (new revision,
 * 409-aware), Save as, Import / Export JSON, Reset to template and History (saved revisions; an admin restores one
 * into the draft), and inline validation (client-side mirror of the server's rules, then the server's own
 * `POST /workflows/validate`).
 *
 * (7.52.00 C2) The canvas is the one flow canvas (FlowCanvas.tsx) in `build` mode for an administrator and `view`
 * mode otherwise, its nodes in their kinds' shapes; the inspector (FlowInspector.tsx, through NodeConfigPanel) is a
 * 360 px docked column from `lg` and the app's SideSheet below it. The palette is grouped by kind and, in an
 * engineering flow, offers the Registry's cards, the gate packs and the library's flows. A flow other automations
 * run is SHARED: a banner names them, and Save asks first, then saves with `confirm_shared` (a 409 `shared_flow`,
 * someone started using it meanwhile, asks too).
 *
 * Non-admins (and the built-in template) get the same view read-only; the built-in template can only be copied
 * ("Save as"). With `unsaved` (a default engineering flow's copy) nothing is stored yet: the copy is the draft, Save
 * creates it as a new workflow (then the host opens it, as after Save as), and Save as, Reset and History, which need
 * a stored workflow, are not offered.
 *
 * @module components/WorkflowEditor/WorkflowEditor
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { workflowIssueText } from './workflowIssueText'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import SideSheet from '../SideSheet/SideSheet'
import { useUnsavedChangesGuard } from '../UnsavedChangesGuard/useUnsavedChangesGuard'
import { pathOrQueryChanged } from '../UnsavedChangesGuard/pathOrQueryChanged'
import { NodeConfigPanel } from './NodeConfigPanel'
import { NodePalette } from './NodePalette'
import { FlowCanvas } from './FlowCanvas'
import { NameDialog } from '../NameDialog/NameDialog'
import { WorkflowHistory } from './WorkflowHistory'
import { addBlock, addBlockAfter, clearDefinition, STEP_HEIGHT } from './model'
import { EMPTY_SELECTION, sameSelection, selectStep, viewOf } from './selection'
import { groupIssues, useWorkflowEditor } from './useWorkflowEditor'
import { EditActions, EditorTitle, SharedFlowBanner, SharedFlowConfirm, StatusLine } from './EditorParts'
import { savesAsNew, usePaletteSources, useWideScreen } from './editorHooks'
import { API_WORKFLOW_LIMITS } from '../../api/workflowsApi'
import type { CanvasSelection } from './selection'
import type { EditorOutcome } from './EditorParts'
import type { EditorSaveOptions } from './useWorkflowEditor'
import type { RestoredRevision } from './WorkflowHistory'
import type { FlowSelection, SelectHow } from './FlowCanvas'
import type { PaletteBlock } from './model'
import MethodologyWarnings from './MethodologyWarnings'
import type { WorkflowDefinition, WorkflowView } from '../../api/workflowsApi'

interface WorkflowEditorProps {
  workflowId: string
  canEdit: boolean
  /**
   * After "Save as": the new workflow, which now holds the draft. The host
   * switches to it (the agent page re-points the agent, the workflow page
   * navigates); either way the editor is re-keyed on the new id.
   */
  onSavedAs?: (workflow: WorkflowView) => void
  /** A confirmation shown in the status line while nothing has changed (e.g. after Save as). */
  notice?: string
  /** A definition to edit that is not stored yet (`workflowId` is then ''): unsaved until Save creates it. */
  unsaved?: WorkflowDefinition
  /** Told whenever the draft gains or loses unsaved changes (the flow page's Start a run runs the saved version). */
  onDirtyChange?: (dirty: boolean) => void
  /** (7.52.00) The automation whose page hosts the editor: its own use of the flow needs no shared-flow confirmation. */
  agentId?: string
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

type Editor = ReturnType<typeof useWorkflowEditor>

export function WorkflowEditor({
  workflowId, canEdit, onSavedAs, notice, unsaved, onDirtyChange, agentId,
}: Readonly<WorkflowEditorProps>) {
  const { t } = useTranslation('agents')
  const editor = useWorkflowEditor(workflowId, canEdit, unsaved, agentId)
  useEffect(() => { onDirtyChange?.(editor.dirty) }, [editor.dirty, onDirtyChange])
  // The status line's outcome, here so the leave-page prompt's Save shows it like the toolbar's.
  const [outcome, setOutcome] = useState<EditorOutcome>(null)
  // After Save as the draft lives in the copy: moving to it is not leaving unsaved work.
  const handedOff = useRef(false)
  // Shared unsaved-changes guard (E2E F6). The built-in template has no Save, only Save as.
  const guard = useUnsavedChangesGuard({
    dirty: canEdit && editor.dirty,
    canSave: !editor.builtin,
    // The toolbar's own Save (its checks, its outcome on the status line); the person then leaves as they asked. A
    // shared flow is saved this way only once confirmed, so here it is held (the editor's Save asks).
    onSave: async () => {
      const { outcome: saved } = await editor.saveOrCreate()
      setOutcome(saved)
      return saved === 'saved'
    },
    shouldBlock: (current, next) => !handedOff.current && pathOrQueryChanged(current, next),
  })
  const savedAs = (workflow: WorkflowView) => {
    handedOff.current = true
    onSavedAs?.(workflow)
  }
  if (editor.query.isLoading) return <div className="skeleton h-[480px]" />
  if (editor.query.isError || editor.draft === null || editor.workflow === undefined) {
    return <p className="card text-sm text-danger">{t('editor.loadFailed')}</p>
  }
  return (
    <>
      <EditorBody editor={editor} draft={editor.draft} workflow={editor.workflow} canEdit={canEdit} onSavedAs={savedAs} notice={notice}
        outcome={outcome} setOutcome={setOutcome} />
      {guard.dialog}
    </>
  )
}

/** Whether Save is offered now (an unsaved copy only where it can be created), and whether a save is under way. */
function saveState(editor: Editor, canEdit: boolean, draft: WorkflowDefinition): { canSave: boolean; saving: boolean } {
  const saving = editor.saving || editor.savingAs
  return { saving, canSave: canEdit && !editor.builtin && editor.dirty && !saving && (!editor.unsaved || savesAsNew(draft)) }
}

/** The saved revisions, for a stored workflow (an unsaved copy has none). */
function StoredHistory({ editor, workflow, onRestore }: Readonly<{
  editor: Editor; workflow: WorkflowView; onRestore?: (restored: RestoredRevision) => void
}>) {
  if (editor.unsaved) return null
  return (
    <WorkflowHistory workflowId={workflow.workflow_id} revisions={editor.revisions} currentRevision={workflow.revision}
      currentDefinition={workflow.definition} onRestore={onRestore} />
  )
}

/** The stale-save banner: save the draft as a copy, or load the latest revision. */
function ConflictBanner({ conflict, draft, onSaveAs, onReload }: Readonly<{
  conflict: boolean; draft: WorkflowDefinition; onSaveAs: () => void; onReload: () => void
}>) {
  const { t } = useTranslation('agents')
  if (!conflict) return null
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warn/30 bg-warn-subtle px-3 py-2 text-sm text-text">
      <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
      <span className="mr-auto">{t('editor.conflict')}</span>
      {savesAsNew(draft) && <button type="button" className="btn btn-secondary btn-sm" onClick={onSaveAs}>{t('editor.conflictSaveAs')}</button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReload}>{t('editor.conflictReload')}</button>
    </div>
  )
}

/** The validation messages that belong to no step. */
function GeneralIssues({ issues }: Readonly<{ issues: readonly string[] }>) {
  const { t } = useTranslation('agents')
  if (issues.length === 0) return null
  return (
    <ul className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger space-y-0.5" aria-label={t('editor.generalIssues')}>
      {issues.map((message) => <li key={message}>{workflowIssueText(t, message)}</li>)}
    </ul>
  )
}

/** Reset, Clear canvas and History's Restore, each confirmed first. */
function EditorConfirmations({ reset, clear, restore, onReset, onClear, onRestore, onCancel }: Readonly<{
  reset: boolean; clear: boolean; restore: RestoredRevision | null
  onReset: () => void; onClear: () => void; onRestore: (restored: RestoredRevision) => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <ConfirmModal isOpen={reset} title={t('editor.resetTitle')} message={t('editor.resetMessage')} confirmLabel={t('editor.reset')}
        cancelLabel={t('common.cancel')} variant="warning" onConfirm={onReset} onCancel={onCancel} />
      <ConfirmModal isOpen={clear} title={t('editor.clearTitle')} message={t('editor.clearMessage')} confirmLabel={t('editor.clear')}
        cancelLabel={t('common.cancel')} variant="warning" onConfirm={onClear} onCancel={onCancel} />
      <ConfirmModal isOpen={restore !== null} title={t('editor.history.confirmTitle')}
        message={t('editor.history.confirmMessage', { revision: restore?.revision ?? 0 })} confirmLabel={t('editor.history.confirmAction')}
        cancelLabel={t('common.cancel')} variant="warning" onConfirm={() => { if (restore !== null) onRestore(restore) }} onCancel={onCancel} />
    </>
  )
}

/**
 * Save, asking first for a shared flow (and again when the server says someone started using it meanwhile), then
 * saving with `confirm_shared`. An unsaved copy's Save creates it (the library's own create), then the host opens it.
 */
function useSharedSave(editor: Editor, onSavedAs: (workflow: WorkflowView) => void, setOutcome: (outcome: EditorOutcome) => void) {
  const [asking, setAsking] = useState(false)
  const save = async (options: EditorSaveOptions = {}) => {
    const { outcome: saved, created } = await editor.saveOrCreate(options)
    if (saved === 'shared') setAsking(true)
    else if (created === undefined) setOutcome(saved)
    else onSavedAs(created)
  }
  return {
    asking,
    onSave: () => {
      if (editor.sharedWith.length > 0) setAsking(true)
      else void save()
    },
    confirm: () => { setAsking(false); void save({ confirmShared: true }) },
    cancel: () => setAsking(false),
  }
}

/** The one step selected, if one is. */
const onlyStep = (selection: CanvasSelection): string | null => (selection.nodeIds.length === 1 ? selection.nodeIds[0] ?? null : null)

/** A palette item added: after the selected step and connected (Enter: `after` is that step or null), else below the graph. */
function paletteAdd(draft: WorkflowDefinition, block: PaletteBlock, after: string | null | undefined) {
  if (after !== undefined) return addBlockAfter(draft, block, after)
  const lowest = Math.max(0, ...draft.nodes.map((n) => n.position.y))
  return addBlock(draft, block, { x: 0, y: lowest + STEP_HEIGHT * 2 })
}

function EditorBody({ editor, draft, workflow, canEdit, onSavedAs, notice, outcome, setOutcome }: Readonly<{
  editor: Editor; draft: WorkflowDefinition; workflow: WorkflowView; canEdit: boolean; onSavedAs: (workflow: WorkflowView) => void
  notice?: string; outcome: EditorOutcome; setOutcome: (outcome: EditorOutcome) => void
}>) {
  const { t } = useTranslation('agents')
  const [selection, setSelectionState] = useState<CanvasSelection>(EMPTY_SELECTION)
  const [focusHeading, setFocusHeading] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<RestoredRevision | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const wide = useWideScreen()
  const readOnly = !canEdit
  const grouped = useMemo(() => groupIssues(editor.issues), [editor.issues])
  const palette = usePaletteSources(draft, workflow.workflow_id, editor.usedBy)
  // The canvas echoes every selection back (React Flow reports what it applied):
  // keep the current object when nothing changed, so the echo is not re-applied.
  const setSelection = useCallback((next: CanvasSelection) => {
    setSelectionState((current) => (sameSelection(current, next) ? current : next))
  }, [])
  const onCanvasSelect = useCallback((_picked: FlowSelection, how?: SelectHow) => setFocusHeading(how?.keyboard === true), [])

  const edit = (next: WorkflowDefinition) => {
    setOutcome(null)
    editor.setDraft(next)
  }
  const addFromPalette = (block: PaletteBlock, after: boolean) => {
    const { definition, nodeId } = paletteAdd(draft, block, after ? onlyStep(selection) : undefined)
    edit(definition)
    setSelection(selectStep(nodeId))
    setFocusHeading(after)
  }
  const clearCanvas = () => {
    setConfirmClear(false)
    edit(clearDefinition(draft))
    setSelection(EMPTY_SELECTION)
  }
  // History → Restore: the revision becomes the draft (unsaved); unsaved edits are confirmed away first.
  const applyRestore = ({ definition }: RestoredRevision) => {
    setPendingRestore(null)
    edit(definition)
    setSelection(EMPTY_SELECTION)
  }
  const requestRestore = (restored: RestoredRevision) => {
    if (editor.dirty) setPendingRestore(restored)
    else applyRestore(restored)
  }
  const shared = useSharedSave(editor, onSavedAs, setOutcome)
  const onSaveAs = async (name: string) => {
    try {
      const created = await editor.saveAs(name)
      setSaveAsOpen(false)
      onSavedAs(created)
    } catch {
      setOutcome('failed')
    }
  }
  const onImportFile = async (file: File | undefined) => {
    if (file === undefined) return
    setOutcome(editor.importJson(await file.text()) ? null : 'import_failed')
    setSelection(EMPTY_SELECTION)
  }
  const onExport = async () => {
    try {
      // An unsaved copy has neither a slug nor an id yet.
      downloadJson(`${workflow.slug || workflow.workflow_id || 'workflow'}.workflow.json`, await editor.exportJson())
    } catch {
      setOutcome('failed')
    }
  }

  const { canSave, saving } = saveState(editor, canEdit, draft)
  const stored = editor.unsaved ? null : workflow.workflow_id
  const panel = (
    <NodeConfigPanel definition={draft} selection={selection} issuesByNode={grouped.byNode} generalIssues={grouped.general}
      readOnly={readOnly} onChange={edit} onSelect={setSelection} workflowId={stored} focusHeading={focusHeading} />
  )
  const sheetOpen = !wide && viewOf(draft, selection).kind !== 'workflow'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <EditorTitle name={draft.name} builtin={editor.builtin} dirty={editor.dirty} />
        <StatusLine outcome={outcome} dirty={editor.dirty} issueCount={editor.issues.length} notice={notice} />
        {canEdit && (
          <EditActions draft={draft} unsaved={editor.unsaved} canSave={canSave} saving={saving}
            onSave={shared.onSave}
            onSaveAs={() => setSaveAsOpen(true)} onImport={() => fileInput.current?.click()}
            onReset={() => setConfirmReset(true)} onClear={() => setConfirmClear(true)} />
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onExport()}>
          <Download size={14} aria-hidden="true" /> {t('editor.export')}
        </button>
        <StoredHistory editor={editor} workflow={workflow} onRestore={canEdit ? requestRestore : undefined} />
        <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { void onImportFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>

      <SharedFlowBanner automations={editor.sharedWith} />

      <ConflictBanner conflict={editor.conflict} draft={draft} onSaveAs={() => setSaveAsOpen(true)} onReload={() => void editor.reloadLatest()} />
      <GeneralIssues issues={grouped.general} />

      <MethodologyWarnings warnings={editor.methodologyWarnings} definition={draft} />

      <div className="grid gap-3 lg:grid-cols-[200px_minmax(0,1fr)_360px]">
        {/* Both side columns scroll, so both are focusable (a read-only editor
            has nothing focusable inside them: E2E F8), and both are named — two
            unnamed asides next to the app sidebar fail axe landmark-unique (F9). */}
        <aside tabIndex={0} className="card p-3 max-h-[640px] overflow-y-auto focus-ring" aria-label={t('editor.palette')}>
          <NodePalette onAdd={addFromPalette} disabled={readOnly} schema={draft.schema} sources={palette} />
        </aside>
        <div className="card p-0 h-[640px] overflow-hidden">
          <FlowCanvas definition={draft} mode={readOnly ? 'view' : 'build'} issuesByNode={grouped.byNode}
            selection={selection} onChange={edit} onSelectionChange={setSelection} onSelect={onCanvasSelect} />
        </div>
        <aside tabIndex={0} className="card p-3 max-h-[640px] overflow-y-auto focus-ring" aria-label={t('editor.panel')}>
          {sheetOpen ? <NodeConfigPanel {...panelProps(draft, grouped, readOnly, edit, setSelection)} selection={EMPTY_SELECTION} /> : panel}
        </aside>
      </div>
      <SideSheet isOpen={sheetOpen} onClose={() => setSelection(EMPTY_SELECTION)} title={t('inspector.sheetTitle')}>
        {panel}
      </SideSheet>

      {saveAsOpen && (
        <NameDialog title={t('editor.saveAsTitle')} submitLabel={t('editor.saveAs')}
          label={t('editor.fields.workflowName')} maxLength={API_WORKFLOW_LIMITS.maxNameChars}
          initialName={t('editor.copyName', { name: draft.name })} saving={editor.savingAs}
          onSave={(name) => void onSaveAs(name)} onClose={() => setSaveAsOpen(false)} />
      )}
      <SharedFlowConfirm automations={editor.sharedWith} open={shared.asking} onConfirm={shared.confirm} onCancel={shared.cancel} />
      <EditorConfirmations reset={confirmReset} clear={confirmClear} restore={pendingRestore}
        onReset={() => { setConfirmReset(false); void editor.resetToTemplate().then(() => setSelection(EMPTY_SELECTION)) }}
        onClear={clearCanvas} onRestore={applyRestore}
        onCancel={() => { setConfirmReset(false); setConfirmClear(false); setPendingRestore(null) }} />
    </div>
  )
}

/** The docked column's props while the inspector is a sheet (it shows the flow's details meanwhile). */
function panelProps(draft: WorkflowDefinition, grouped: ReturnType<typeof groupIssues>, readOnly: boolean,
  onChange: (definition: WorkflowDefinition) => void, onSelect: (selection: CanvasSelection) => void) {
  return { definition: draft, issuesByNode: grouped.byNode, generalIssues: grouped.general, readOnly, onChange, onSelect }
}
