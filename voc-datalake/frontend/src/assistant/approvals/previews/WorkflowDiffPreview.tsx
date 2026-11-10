/**
 * @fileoverview Workflow approval previews.
 * - `update_workflow`: what the proposed COMPLETE definition adds, removes and
 *   changes relative to the stored current revision (nodes and arrows, loops,
 *   name / description); moves alone are collapsed. A stored revision newer
 *   than `expected_revision` is called out — the save will be refused.
 * - `create_workflow`: the steps and arrows of the new workflow.
 *
 * @module assistant/approvals/previews/WorkflowDiffPreview
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { diffDefinitions } from '../../../components/WorkflowEditor/diff'
import { WorkflowDiffView } from '../../../components/WorkflowEditor/WorkflowDiffView'
import type { CreateWorkflowArgs, UpdateWorkflowArgs } from '../agentSchemas'

export function WorkflowDiffPreview({ args }: Readonly<{ args: UpdateWorkflowArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading, isError } = useQuery({
    queryKey: workflowsKeys.detail(args.workflow_id),
    queryFn: () => workflowsApi.get(args.workflow_id),
    retry: false,
  })
  if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
  const current = data?.workflow
  if (isError || current === undefined) return <p className="text-[12px] text-warn">{t('preview.currentUnavailable')}</p>
  const stale = current.revision !== args.expected_revision
  const diff = diffDefinitions(current.definition, args.definition)
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted">
        {t('preview.workflow.revision', { from: current.revision, to: current.revision + 1, name: current.name })}
      </p>
      {stale && (
        <p role="alert" className="rounded-md border border-warn/30 bg-warn-subtle px-2 py-1 text-[12px] text-text">
          {t('preview.workflow.stale', { expected: args.expected_revision, current: current.revision })}
        </p>
      )}
      <WorkflowDiffView diff={diff} before={current.definition} after={args.definition} />
    </div>
  )
}

export function WorkflowCreatePreview({ args }: Readonly<{ args: CreateWorkflowArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { definition } = args
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-text-strong">{definition.name}</p>
      <p className="text-[12px] text-muted">
        {t('preview.workflow.counts', { nodes: definition.nodes.length, edges: definition.edges.length, loops: definition.loops.length })}
      </p>
      <ol className="list-decimal pl-5 text-sm text-text space-y-0.5">
        {definition.nodes.map((n) => <li key={n.id}>{n.data.title} <span className="text-[12px] text-muted font-mono">{n.type}</span></li>)}
      </ol>
    </div>
  )
}
