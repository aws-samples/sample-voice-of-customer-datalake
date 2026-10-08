/**
 * @fileoverview The free-form workflow editor: palette · canvas · side panel,
 * with a toolbar for Save (new revision, 409-aware), Save as, Import / Export
 * JSON and Reset to template, and inline validation (client-side mirror of the
 * server's rules, then the server's own `POST /workflows/validate`).
 *
 * Non-admins (and the built-in template) get the same view read-only; the
 * built-in template can only be copied ("Save as").
 *
 * @module components/WorkflowEditor/WorkflowEditor
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, Eraser, Loader2, RotateCcw, Save, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import ModalShell from '../ModalShell/ModalShell'
import { useUnsavedChangesGuard } from '../UnsavedChangesGuard/useUnsavedChangesGuard'
import { NodeConfigPanel } from './NodeConfigPanel'
import { NodePalette } from './NodePalette'
import { WorkflowCanvas } from './WorkflowCanvas'
import { addNode, clearDefinition, STEP_HEIGHT } from './model'
import { EMPTY_SELECTION, sameSelection, selectStep } from './selection'
import { groupIssues, useWorkflowEditor } from './useWorkflowEditor'
import { API_WORKFLOW_LIMITS } from '../../api/workflowsApi'
import type { CanvasSelection } from './selection'
import type { SaveOutcome } from './useWorkflowEditor'
import type { WorkflowDefinition, WorkflowNodeType, WorkflowView } from '../../api/workflowsApi'

interface WorkflowEditorProps {
  workflowId: string
  canEdit: boolean
  /** After "Save as": the new workflow (the agent page offers to switch to it). */
  onSavedAs?: (workflow: WorkflowView) => void
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

function SaveAsDialog({ initialName, saving, onSave, onClose }: Readonly<{
  initialName: string; saving: boolean; onSave: (name: string) => void; onClose: () => void
}>) {
  const { t } = useTranslation('agents')
  const [name, setName] = useState(initialName)
  const titleId = useId()
  const inputId = useId()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-md">
      <div className="dialog-header"><h2 id={titleId} className="dialog-title">{t('editor.saveAsTitle')}</h2></div>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (name.trim() !== '') onSave(name.trim()) }}>
        <div className="dialog-body space-y-1">
          <label htmlFor={inputId} className="block text-[12px] font-medium text-muted">{t('editor.fields.workflowName')}</label>
          <input id={inputId} className="input w-full" value={name} maxLength={API_WORKFLOW_LIMITS.maxNameChars}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || name.trim() === ''}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('editor.saveAs')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function validKey(dirty: boolean, outcome: EditorOutcome): string {
  if (dirty) return 'editor.validUnsaved'
  return outcome === 'saved' ? 'editor.outcome.saved' : 'editor.valid'
}

function StatusLine({ outcome, dirty, issueCount }: Readonly<{ outcome: EditorOutcome; dirty: boolean; issueCount: number }>) {
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
      {t(validKey(dirty, outcome))}
    </span>
  )
}

type Editor = ReturnType<typeof useWorkflowEditor>

export function WorkflowEditor({ workflowId, canEdit, onSavedAs }: Readonly<WorkflowEditorProps>) {
  const { t } = useTranslation('agents')
  const editor = useWorkflowEditor(workflowId, canEdit)
  // Shared unsaved-changes guard (E2E F6). The built-in template has no Save, only Save as.
  const guard = useUnsavedChangesGuard({
    dirty: canEdit && editor.dirty,
    canSave: !editor.builtin,
    onSave: async () => (await editor.save()) === 'saved',
  })
  if (editor.query.isLoading) return <div className="skeleton h-[480px]" />
  if (editor.query.isError || editor.draft === null || editor.workflow === undefined) {
    return <p className="card text-sm text-danger">{t('editor.loadFailed')}</p>
  }
  return (
    <>
      <EditorBody editor={editor} draft={editor.draft} workflow={editor.workflow} canEdit={canEdit} onSavedAs={onSavedAs} />
      {guard.dialog}
    </>
  )
}

function EditorBody({ editor, draft, workflow, canEdit, onSavedAs }: Readonly<{
  editor: Editor; draft: WorkflowDefinition; workflow: WorkflowView; canEdit: boolean; onSavedAs?: (workflow: WorkflowView) => void
}>) {
  const { t } = useTranslation('agents')
  const [selection, setSelectionState] = useState<CanvasSelection>(EMPTY_SELECTION)
  const [outcome, setOutcome] = useState<EditorOutcome>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
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
  const onSave = async () => setOutcome(await editor.save())
  const onSaveAs = async (name: string) => {
    try {
      const created = await editor.saveAs(name)
      setSaveAsOpen(false)
      onSavedAs?.(created)
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
        <div className="mr-auto min-w-0">
          <p className="text-sm font-semibold text-text-strong truncate" title={draft.name}>{draft.name}</p>
          <p className="text-[12px] text-muted">
            <span className="font-mono">{t('editor.revision', { n: workflow.revision })}</span>
            {editor.builtin && <span className="ml-2 badge badge-info">{t('editor.builtin')}</span>}
            {editor.dirty && <span className="ml-2 badge badge-warn">{t('editor.unsaved')}</span>}
          </p>
        </div>
        <StatusLine outcome={outcome} dirty={editor.dirty} issueCount={editor.issues.length} />
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
          {grouped.general.map((message) => <li key={message}>{message}</li>)}
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
        <SaveAsDialog initialName={t('editor.copyName', { name: draft.name })} saving={editor.savingAs}
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
    </div>
  )
}
