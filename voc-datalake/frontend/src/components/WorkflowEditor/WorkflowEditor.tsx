/**
 * @fileoverview The free-form workflow editor: palette · canvas · side panel,
 * with a toolbar for Save (new revision, 409-aware), Save as, Import / Export
 * JSON, Reset to template and History (saved revisions; an admin restores one
 * into the draft), and inline validation (client-side mirror of the
 * server's rules, then the server's own `POST /workflows/validate`).
 *
 * Non-admins (and the built-in template) get the same view read-only; the
 * built-in template can only be copied ("Save as").
 *
 * @module components/WorkflowEditor/WorkflowEditor
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, Eraser, Loader2, RotateCcw, Save, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { workflowIssueText } from './workflowIssueText'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import { useUnsavedChangesGuard } from '../UnsavedChangesGuard/useUnsavedChangesGuard'
import { pathOrQueryChanged } from '../UnsavedChangesGuard/pathOrQueryChanged'
import { NodeConfigPanel } from './NodeConfigPanel'
import { NodePalette } from './NodePalette'
import { WorkflowCanvas } from './WorkflowCanvas'
import { NameDialog } from '../NameDialog/NameDialog'
import { WorkflowHistory } from './WorkflowHistory'
import { addNode, clearDefinition, STEP_HEIGHT } from './model'
import { EMPTY_SELECTION, sameSelection, selectStep } from './selection'
import { groupIssues, useWorkflowEditor } from './useWorkflowEditor'
import { API_WORKFLOW_LIMITS } from '../../api/workflowsApi'
import type { CanvasSelection } from './selection'
import type { SaveOutcome } from './useWorkflowEditor'
import type { RestoredRevision } from './WorkflowHistory'
import type { WorkflowDefinition, WorkflowNodeType, WorkflowView } from '../../api/workflowsApi'
import type { ReactNode } from 'react'

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
  /**
   * Host replacement for the workflow's name at the start of the toolbar (the
   * agent page's workflow switcher); the revision line stays below it. Given
   * whether the draft has unsaved changes and its name, so the host can confirm
   * before replacing the draft.
   */
  renderTitle?: (state: Readonly<{ dirty: boolean; name: string }>) => ReactNode
}

type EditorOutcome = SaveOutcome | 'import_failed' | null

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function validKey(dirty: boolean, outcome: EditorOutcome): string {
  if (dirty) return 'editor.validUnsaved'
  return outcome === 'saved' ? 'editor.outcome.saved' : 'editor.valid'
}

function StatusLine({ outcome, dirty, issueCount, notice }: Readonly<{
  outcome: EditorOutcome; dirty: boolean; issueCount: number; notice?: string
}>) {
  const { t } = useTranslation('agents')
  if (outcome === 'failed' || outcome === 'import_failed' || outcome === 'invalid') {
    return <span role="status" className="text-[12px] text-danger">{t(`editor.outcome.${outcome}`)}</span>
  }
  if (issueCount > 0) {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-[12px] text-danger">
        <AlertTriangle size={13} aria-hidden="true" /> {t('editor.issueCount', { count: issueCount })}
      </span>
    )
  }
  return (
    <span role="status" className="inline-flex items-center gap-1 text-[12px] text-muted">
      <CheckCircle2 size={13} className="text-ok" aria-hidden="true" />
      {notice !== undefined && !dirty && outcome === null ? notice : t(validKey(dirty, outcome))}
    </span>
  )
}

type Editor = ReturnType<typeof useWorkflowEditor>

export function WorkflowEditor({ workflowId, canEdit, onSavedAs, notice, renderTitle }: Readonly<WorkflowEditorProps>) {
  const { t } = useTranslation('agents')
  const editor = useWorkflowEditor(workflowId, canEdit)
  // After Save as the draft lives in the copy: moving to it is not leaving unsaved work.
  const handedOff = useRef(false)
  // Shared unsaved-changes guard (E2E F6). The built-in template has no Save, only Save as.
  const guard = useUnsavedChangesGuard({
    dirty: canEdit && editor.dirty,
    canSave: !editor.builtin,
    onSave: async () => (await editor.save()) === 'saved',
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
        title={renderTitle?.({ dirty: canEdit && editor.dirty, name: editor.draft.name })} />
      {guard.dialog}
    </>
  )
}

/** The toolbar's title: the host's (the agent page's workflow picker) or the workflow's name, then its badges. */
function EditorTitle({ title, name, builtin, dirty }: Readonly<{ title?: ReactNode; name: string; builtin: boolean; dirty: boolean }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="mr-auto min-w-0">
      {title ?? <p className="text-sm font-semibold text-text-strong truncate" title={name}>{name}</p>}
      {(builtin || dirty) && (
        <p className="flex gap-2 text-[12px] text-muted">
          {builtin && <span className="badge badge-info">{t('editor.builtin')}</span>}
          {dirty && <span className="badge badge-warn">{t('editor.unsaved')}</span>}
        </p>
      )}
    </div>
  )
}

function EditorBody({ editor, draft, workflow, canEdit, onSavedAs, notice, title }: Readonly<{
  editor: Editor; draft: WorkflowDefinition; workflow: WorkflowView; canEdit: boolean; onSavedAs: (workflow: WorkflowView) => void
  notice?: string; title?: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const [selection, setSelectionState] = useState<CanvasSelection>(EMPTY_SELECTION)
  const [outcome, setOutcome] = useState<EditorOutcome>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<RestoredRevision | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const readOnly = !canEdit
  const grouped = useMemo(() => groupIssues(editor.issues), [editor.issues])
  // The canvas echoes every selection back (React Flow reports what it applied):
  // keep the current object when nothing changed, so the echo is not re-applied.
  const setSelection = useCallback((next: CanvasSelection) => {
    setSelectionState((current) => (sameSelection(current, next) ? current : next))
  }, [])

  const edit = (next: WorkflowDefinition) => {
    setOutcome(null)
    editor.setDraft(next)
  }
  const addFromPalette = (type: WorkflowNodeType) => {
    const lowest = Math.max(0, ...draft.nodes.map((n) => n.position.y))
    const { definition, nodeId } = addNode(draft, type, { x: 0, y: lowest + STEP_HEIGHT * 2 }, t(`nodeTypes.${type}.label`))
    edit(definition)
    setSelection(selectStep(nodeId))
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
  const onSave = async () => setOutcome(await editor.save())
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
      downloadJson(`${workflow.slug || workflow.workflow_id}.workflow.json`, await editor.exportJson())
    } catch {
      setOutcome('failed')
    }
  }

  const canSave = canEdit && !editor.builtin && editor.dirty && !editor.saving
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <EditorTitle title={title} name={draft.name} builtin={editor.builtin} dirty={editor.dirty} />
        <StatusLine outcome={outcome} dirty={editor.dirty} issueCount={editor.issues.length} notice={notice} />
        {canEdit && (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={!canSave} onClick={() => void onSave()}>
              {editor.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
              {t('editor.save')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSaveAsOpen(true)}>
              <Copy size={14} aria-hidden="true" /> {t('editor.saveAs')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()}>
              <Upload size={14} aria-hidden="true" /> {t('editor.import')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(true)}>
              <RotateCcw size={14} aria-hidden="true" /> {t('editor.reset')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={draft.nodes.length === 0} onClick={() => setConfirmClear(true)}>
              <Eraser size={14} aria-hidden="true" /> {t('editor.clear')}
            </button>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onExport()}>
          <Download size={14} aria-hidden="true" /> {t('editor.export')}
        </button>
        <WorkflowHistory workflowId={workflow.workflow_id} revisions={editor.revisions} currentRevision={workflow.revision}
          currentDefinition={workflow.definition} onRestore={canEdit ? requestRestore : undefined} />
        <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { void onImportFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>

      {editor.conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warn/30 bg-warn-subtle px-3 py-2 text-sm text-text">
          <AlertTriangle size={14} className="text-warn" aria-hidden="true" />
          <span className="mr-auto">{t('editor.conflict')}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSaveAsOpen(true)}>{t('editor.conflictSaveAs')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void editor.reloadLatest()}>{t('editor.conflictReload')}</button>
        </div>
      )}

      {grouped.general.length > 0 && (
        <ul className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger space-y-0.5" aria-label={t('editor.generalIssues')}>
          {grouped.general.map((message) => <li key={message}>{workflowIssueText(t, message)}</li>)}
        </ul>
      )}

      <div className="grid gap-3 lg:grid-cols-[200px_minmax(0,1fr)_280px]">
        {/* Both side columns scroll, so both are focusable (a read-only editor
            has nothing focusable inside them: E2E F8), and both are named — two
            unnamed asides next to the app sidebar fail axe landmark-unique (F9). */}
        <aside tabIndex={0} className="card p-3 max-h-[640px] overflow-y-auto focus-ring" aria-label={t('editor.palette')}>
          <NodePalette onAdd={addFromPalette} disabled={readOnly} />
        </aside>
        <div className="card p-0 h-[640px] overflow-hidden">
          <WorkflowCanvas definition={draft} readOnly={readOnly} issuesByNode={grouped.byNode}
            selection={selection} onChange={edit} onSelectionChange={setSelection} />
        </div>
        <aside tabIndex={0} className="card p-3 max-h-[640px] overflow-y-auto focus-ring" aria-label={t('editor.panel')}>
          <NodeConfigPanel definition={draft} selection={selection} issuesByNode={grouped.byNode} generalIssues={grouped.general}
            readOnly={readOnly} onChange={edit} onSelect={setSelection} />
        </aside>
      </div>

      {saveAsOpen && (
        <NameDialog title={t('editor.saveAsTitle')} submitLabel={t('editor.saveAs')}
          label={t('editor.fields.workflowName')} maxLength={API_WORKFLOW_LIMITS.maxNameChars}
          initialName={t('editor.copyName', { name: draft.name })} saving={editor.savingAs}
          onSave={(name) => void onSaveAs(name)} onClose={() => setSaveAsOpen(false)} />
      )}
      <ConfirmModal
        isOpen={confirmReset}
        title={t('editor.resetTitle')}
        message={t('editor.resetMessage')}
        confirmLabel={t('editor.reset')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={() => { setConfirmReset(false); void editor.resetToTemplate().then(() => setSelection(EMPTY_SELECTION)) }}
        onCancel={() => setConfirmReset(false)}
      />
      <ConfirmModal
        isOpen={confirmClear}
        title={t('editor.clearTitle')}
        message={t('editor.clearMessage')}
        confirmLabel={t('editor.clear')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={clearCanvas}
        onCancel={() => setConfirmClear(false)}
      />
      <ConfirmModal
        isOpen={pendingRestore !== null}
        title={t('editor.history.confirmTitle')}
        message={t('editor.history.confirmMessage', { revision: pendingRestore?.revision ?? 0 })}
        confirmLabel={t('editor.history.confirmAction')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={() => { if (pendingRestore !== null) applyRestore(pendingRestore) }}
        onCancel={() => setPendingRestore(null)}
      />
    </div>
  )
}
