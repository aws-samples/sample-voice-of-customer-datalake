/**
 * @fileoverview The workflow library (admins): every stored workflow with its
 * revision, Open (the workflow's own page, `/agents/workflows/:workflowId`),
 * Rename (a new revision with only the name changed), New workflow (a dialog
 * asks for the name and an optional description; only its submit creates the
 * Start → End workflow, which then opens), and Archive for the ones no active agent runs. The
 * built-in template can be neither renamed nor archived.
 *
 * Archiving is soft (`DELETE /workflows/{id}`): the workflow leaves the library
 * and the agent workflow picker, becomes read-only, and keeps its revisions. A
 * "Save as" or an import leaves the previous workflow behind, and before this
 * there was no way to remove it.
 *
 * @module pages/Agents/WorkflowLibrary
 */
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, FolderOpen, Loader2, Pencil, Plus, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { starterDefinition } from '../../components/WorkflowEditor/model'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { failedReads } from '../../utils/failedReads'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { API_WORKFLOW_LIMITS, seedWorkflowDetail, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { workflowPath } from './workflowPaths'
import type { WorkflowSummary } from '../../api/workflowsApi'

function renameErrorKey(error: unknown): string {
  return apiErrorStatus(error) === 409 ? 'library.renameConflict' : 'library.renameFailed'
}

function archiveErrorKey(error: unknown): string {
  return apiErrorStatus(error) === 409 ? 'library.archiveInUse' : 'library.archiveFailed'
}

function WorkflowRow({ workflow, archiving, onArchive, onRename }: Readonly<{
  workflow: WorkflowSummary; archiving: boolean; onArchive: () => void; onRename: () => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Workflow size={16} className="text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-strong break-words [overflow-wrap:anywhere]">{workflow.name}</p>
        <p className="text-[12px] text-muted font-mono">{t('editor.revision', { n: workflow.revision })}</p>
      </div>
      {workflow.builtin && <span className="badge badge-info">{t('editor.builtin')}</span>}
      <Link to={workflowPath(workflow.workflow_id)} className="btn btn-secondary btn-sm"
        aria-label={t('library.openNamed', { name: workflow.name })}>
        <FolderOpen size={14} aria-hidden="true" /> {t('library.open')}
      </Link>
      {!workflow.builtin && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRename}
          aria-label={t('library.renameNamed', { name: workflow.name })}>
          <Pencil size={14} aria-hidden="true" /> {t('library.rename')}
        </button>
      )}
      {!workflow.builtin && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={archiving} onClick={onArchive}
          aria-label={t('library.archiveNamed', { name: workflow.name })}>
          {archiving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          {t('library.archive')}
        </button>
      )}
    </li>
  )
}

/** "New workflow": a valid Start → End workflow with the name (and description) asked for, created and opened. */
function useNewWorkflow() {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, description }: Readonly<{ name: string; description: string }>) => workflowsApi.create({
      ...starterDefinition({ name, start: t('nodeTypes.start.label'), end: t('nodeTypes.end.label') }),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
    }),
    onSuccess: (view) => {
      seedWorkflowDetail(queryClient, view)
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.list() })
      void navigate(workflowPath(view.workflow_id))
    },
  })
}

export function WorkflowLibrary() {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const workflowsQuery = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list })
  const { data: workflows, isLoading } = workflowsQuery
  const failure = failedReads([workflowsQuery])
  const [pending, setPending] = useState<WorkflowSummary | null>(null)
  const titleId = useId()
  const create = useNewWorkflow()
  const [creating, setCreating] = useState(false)
  const archive = useMutation({
    mutationFn: (id: string) => workflowsApi.archive(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: workflowsKeys.all() }) },
  })
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null)
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => workflowsApi.rename(id, name),
    onSuccess: () => {
      setRenaming(null)
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.all() })
    },
  })
  const confirm = () => {
    if (pending === null) return
    archive.mutate(pending.workflow_id)
    setPending(null)
  }
  return (
    <section className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h2 id={titleId} className="text-base font-semibold tracking-tight text-text-strong">{t('library.title')}</h2>
          <p className="text-sm text-muted">{t('library.subtitle')}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { create.reset(); setCreating(true) }}>
          <Plus size={14} aria-hidden="true" /> {t('library.newWorkflow')}
        </button>
      </div>
      {isLoading && <div className="skeleton h-16" />}
      {failure.loadFailed && <LoadFailed message={t('library.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {archive.isError && <p role="alert" className="text-[12px] text-danger">{t(archiveErrorKey(archive.error))}</p>}
      {workflows !== undefined && (
        <ul className="card p-0 divide-y divide-border">
          {workflows.map((workflow) => (
            <WorkflowRow key={workflow.workflow_id} workflow={workflow}
              archiving={archive.isPending && archive.variables === workflow.workflow_id}
              onArchive={() => { archive.reset(); setPending(workflow) }}
              onRename={() => { rename.reset(); setRenaming(workflow) }} />
          ))}
        </ul>
      )}
      {renaming !== null && (
        <NameDialog title={t('library.renameTitle')} submitLabel={t('library.rename')} initialName={renaming.name}
          label={t('editor.fields.workflowName')} maxLength={API_WORKFLOW_LIMITS.maxNameChars}
          saving={rename.isPending} error={rename.isError ? t(renameErrorKey(rename.error)) : undefined}
          onSave={(name) => rename.mutate({ id: renaming.workflow_id, name })} onClose={() => setRenaming(null)} />
      )}
      {creating && (
        <NameDialog title={t('library.createTitle')} hint={t('library.createHint')} submitLabel={t('library.create')} initialName=""
          label={t('editor.fields.workflowName')} maxLength={API_WORKFLOW_LIMITS.maxNameChars}
          description={{ label: t('editor.fields.description'), maxLength: API_WORKFLOW_LIMITS.maxDescriptionChars }}
          saving={create.isPending} error={create.isError ? t('library.newWorkflowFailed') : undefined}
          onSave={(name, description) => create.mutate({ name, description })} onClose={() => setCreating(false)} />
      )}
      <ConfirmModal
        isOpen={pending !== null}
        title={t('library.archiveTitle')}
        message={t('library.archiveMessage', { name: pending?.name ?? '' })}
        confirmLabel={t('library.archive')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </section>
  )
}
