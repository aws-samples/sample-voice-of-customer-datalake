/**
 * @fileoverview The workflow editor's toolbar and banners (split from WorkflowEditor.tsx in 7.52.00 C2): the status
 * line, the title, the editing actions; (7.52.00) the SHARED-FLOW banner, "Used by" the automations other than this
 * page's that run the flow, whose save changes each of them from its next run, and its confirmation; what the
 * palette is built from (the Registry, the gates, the library and who calls this flow); and whether the screen is
 * wide enough to dock the inspector (from `lg`; below it the inspector is a side sheet).
 *
 * @module components/WorkflowEditor/EditorParts
 */
import { AlertTriangle, CheckCircle2, Copy, Eraser, Loader2, RotateCcw, Save, Upload, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import Notice from '../Notice/Notice'
import { TruncatedText } from '../Tooltip/TruncatedText'
import { isEngineeringFlow } from '../../api/workflowsApi'
import { savesAsNew, useNames } from './editorHooks'
import type { ReactNode } from 'react'
import type { UsingAutomation, WorkflowDefinition } from '../../api/workflowsApi'
import type { SaveOutcome } from './useWorkflowEditor'

export type EditorOutcome = SaveOutcome | 'import_failed' | null

function validKey(dirty: boolean, outcome: EditorOutcome): string {
  if (dirty) return 'editor.validUnsaved'
  return outcome === 'saved' ? 'editor.outcome.saved' : 'editor.valid'
}

export function StatusLine({ outcome, dirty, issueCount, notice }: Readonly<{
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

/** The toolbar's title: the host's (the agent page's workflow picker) or the workflow's name, then its badges. */
export function EditorTitle({ title, name, builtin, dirty }: Readonly<{ title?: ReactNode; name: string; builtin: boolean; dirty: boolean }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="mr-auto min-w-0">
      {title ?? <TruncatedText as="p" className="truncate text-sm font-semibold text-text-strong" text={name} />}
      {(builtin || dirty) && (
        <p className="flex gap-2 text-[12px] text-muted">
          {builtin && <span className="badge badge-info">{t('editor.builtin')}</span>}
          {dirty && <span className="badge badge-warn">{t('editor.unsaved')}</span>}
        </p>
      )}
    </div>
  )
}

/**
 * The editing half of the toolbar: Save, Save as, Import, Reset, Clear (an unsaved copy: Save, Import, Clear; an
 * engineering flow: no Reset).
 */
export function EditActions({ draft, unsaved, canSave, saving, onSave, onSaveAs, onImport, onReset, onClear }: Readonly<{
  draft: WorkflowDefinition; unsaved: boolean; canSave: boolean; saving: boolean
  onSave: () => void; onSaveAs: () => void; onImport: () => void; onReset: () => void; onClear: () => void
}>) {
  const { t } = useTranslation('agents')
  const canSaveAs = !unsaved && savesAsNew(draft)
  // Reset loads the built-in template, an agents workflow: never offered on an engineering flow (it keeps its kind),
  // nor on an unsaved copy.
  const canReset = !unsaved && !isEngineeringFlow(draft)
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" disabled={!canSave} onClick={onSave}>
        {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
        {t('editor.save')}
      </button>
      {canSaveAs && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSaveAs}>
          <Copy size={14} aria-hidden="true" /> {t('editor.saveAs')}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onImport}>
        <Upload size={14} aria-hidden="true" /> {t('editor.import')}
      </button>
      {canReset && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
          <RotateCcw size={14} aria-hidden="true" /> {t('editor.reset')}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" disabled={draft.nodes.length === 0} onClick={onClear}>
        <Eraser size={14} aria-hidden="true" /> {t('editor.clear')}
      </button>
    </>
  )
}

/** The shared-flow banner: the other automations that run this flow, and what a save does to them. */
export function SharedFlowBanner({ automations }: Readonly<{ automations: readonly UsingAutomation[] }>) {
  const { t } = useTranslation('agents')
  const names = useNames(automations)
  if (automations.length === 0) return null
  return <Notice variant="banner" tone="warn" icon={Users} role="note" text={t('canvas.shared.banner', { count: automations.length, names })} />
}

/** "Save a shared flow?": confirming saves it with `confirm_shared` (for every automation that runs it). */
export function SharedFlowConfirm({ automations, open, onConfirm, onCancel }: Readonly<{
  automations: readonly UsingAutomation[]; open: boolean; onConfirm: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const names = useNames(automations)
  return (
    <ConfirmModal isOpen={open} title={t('canvas.shared.confirmTitle')} message={t('canvas.shared.confirmMessage', { names })}
      confirmLabel={t('canvas.shared.confirmAction')} cancelLabel={t('common.cancel')} variant="warning"
      onConfirm={onConfirm} onCancel={onCancel} />
  )
}

