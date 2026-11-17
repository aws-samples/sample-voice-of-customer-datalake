/**
 * @fileoverview Workflow approval previews.
 * - `update_workflow`: what the proposed COMPLETE definition adds, removes and
 *   changes relative to the stored current revision (nodes and arrows, loops,
 *   name / description, an engineering flow's monthly budget in dollars); moves alone are collapsed. A stored revision newer
 *   than `expected_revision` is called out — the save will be refused. (7.52.00) A flow other automations run says
 *   who: with `confirm_shared`, approving saves it for all of them; without it, the save will be refused.
 * - `create_workflow`: the steps and arrows of the new workflow, and the monthly budget it sets.
 *
 * @module assistant/approvals/previews/WorkflowDiffPreview
 */
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Notice from '../../../components/Notice/Notice'
import { usedByOf, workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { diffDefinitions } from '../../../components/WorkflowEditor/diff'
import { BudgetChange, WorkflowDiffView } from '../../../components/WorkflowEditor/WorkflowDiffView'
import type { CreateWorkflowArgs, UpdateWorkflowArgs } from '../agentSchemas'

/** The automations that run the flow (7.52.00), and what approving this save does to them; nothing when none do. */
function SharedFlowNote({ names, confirmed }: Readonly<{ names: readonly string[]; confirmed: boolean }>) {
  const { t, i18n } = useTranslation('agents')
  if (names.length === 0) return null
  const listed = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(names)
  return (
    <Notice variant="banner" tone="warn" icon={Users} role="note"
      text={confirmed ? t('canvas.shared.approvalNote', { names: listed }) : t('canvas.shared.approvalRefused', { names: listed })} />
  )
}

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
      <SharedFlowNote names={usedByOf(current).automations.map((automation) => automation.name)}
        confirmed={args.confirm_shared === true} />
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
      {definition.budget !== undefined && <BudgetChange before={null} after={definition} />}
      <ol className="list-decimal pl-5 text-sm text-text space-y-0.5">
        {definition.nodes.map((n) => <li key={n.id}>{n.data.title} <span className="text-[12px] text-muted font-mono">{n.type}</span></li>)}
      </ol>
    </div>
  )
}
