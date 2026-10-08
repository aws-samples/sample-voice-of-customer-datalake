/**
 * @fileoverview The workflow library (admins): every stored workflow with its
 * revision, and Archive for the ones no active agent runs.
 *
 * Archiving is soft (`DELETE /workflows/{id}`): the workflow leaves the library
 * and the agent workflow picker, becomes read-only, and keeps its revisions. A
 * "Save as" or an import leaves the previous workflow behind, and before this
 * there was no way to remove it.
 *
 * @module pages/Agents/WorkflowLibrary
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Loader2, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads } from '../../utils/failedReads'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import type { WorkflowSummary } from '../../api/workflowsApi'

function archiveErrorKey(error: unknown): string {
  return apiErrorStatus(error) === 409 ? 'library.archiveInUse' : 'library.archiveFailed'
}

function WorkflowRow({ workflow, archiving, onArchive }: Readonly<{
  workflow: WorkflowSummary; archiving: boolean; onArchive: () => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Workflow size={16} className="text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-strong truncate" title={workflow.name}>{workflow.name}</p>
        <p className="text-[12px] text-muted font-mono">{t('editor.revision', { n: workflow.revision })}</p>
      </div>
      {workflow.builtin ? (
        <span className="badge badge-info">{t('editor.builtin')}</span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" disabled={archiving} onClick={onArchive}
          aria-label={t('library.archiveNamed', { name: workflow.name })}>
          {archiving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          {t('library.archive')}
        </button>
      )}
    </li>
  )
}

export function WorkflowLibrary() {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const workflowsQuery = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list })
  const { data: workflows, isLoading } = workflowsQuery
  const failure = failedReads([workflowsQuery])
  const [pending, setPending] = useState<WorkflowSummary | null>(null)
  const titleId = useId()
  const archive = useMutation({
    mutationFn: (id: string) => workflowsApi.archive(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: workflowsKeys.all() }) },
  })
  const confirm = () => {
    if (pending === null) return
    archive.mutate(pending.workflow_id)
    setPending(null)
  }
  return (
    <section className="space-y-2" aria-labelledby={titleId}>
      <div>
        <h2 id={titleId} className="text-base font-semibold tracking-tight text-text-strong">{t('library.title')}</h2>
        <p className="text-sm text-muted">{t('library.subtitle')}</p>
      </div>
      {isLoading && <div className="skeleton h-16" />}
      {failure.loadFailed && <LoadFailed message={t('library.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {archive.isError && <p role="alert" className="text-[12px] text-danger">{t(archiveErrorKey(archive.error))}</p>}
      {workflows !== undefined && (
        <ul className="card p-0 divide-y divide-border">
          {workflows.map((workflow) => (
            <WorkflowRow key={workflow.workflow_id} workflow={workflow}
              archiving={archive.isPending && archive.variables === workflow.workflow_id}
              onArchive={() => { archive.reset(); setPending(workflow) }} />
          ))}
        </ul>
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
