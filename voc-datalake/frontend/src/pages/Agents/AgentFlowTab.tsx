/**
 * @fileoverview An automation's Flow tab (`/agents/<id>/flow`; 7.52.00 C1, ux-agents-redesign part 4 §4.4 and the
 * roadmap's shared-flows item): the flow it runs, read only, on the shared canvas (components/WorkflowEditor/FlowCanvas).
 * Nothing is edited in place, because a flow may be shared: **Edit in Flows** opens the flow's own page, whose
 * editor says which automations a save changes (7.52.00 C2's banner), and **Run another flow ▾** points the
 * automation at another flow of its kind (an engineering automation an engineering flow, a product one an agents
 * workflow), after a confirmation that it takes effect from its next run. A person who is not an administrator sees
 * the flow alone.
 *
 * @module pages/Agents/AgentFlowTab
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, PencilRuler, Workflow } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import Notice from '../../components/Notice/Notice'
import { RowActionsMenu } from '../../components/RowActionsMenu/RowActionsMenu'
import { FlowCanvas } from '../../components/WorkflowEditor/FlowCanvas'
import { FlowInspector } from '../../components/WorkflowEditor/FlowInspector'
import type { FlowSelection } from '../../components/WorkflowEditor/FlowCanvas'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { isEngineeringAgent } from '../../api/agentsApi'
import { useAgentMutations } from './useAgents'
import { workflowPath } from './workflowPaths'
import type { Agent } from '../../api/agentsApi'
import type { WorkflowSummary } from '../../api/workflowsApi'

/** The flows the automation may run instead: its kind's, active, not the one it runs. */
function useOtherFlows(agent: Agent, current: string, isAdmin: boolean): WorkflowSummary[] {
  const { data = [] } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, enabled: isAdmin, staleTime: 30_000 })
  const engineering = isEngineeringAgent(agent)
  // (the list's entries are the server's as sent, only checked against the schema: a missing kind is an agents workflow)
  return data.filter((flow) => (flow.kind === 'engineering') === engineering && flow.status !== 'archived' && flow.workflow_id !== current)
}

/** "Run another flow ▾": the other flows, then a confirmation; the automation runs the chosen one from its next run. */
function RunAnotherFlow({ agent, current }: Readonly<{ agent: Agent; current: string }>) {
  const { t } = useTranslation('agents')
  const { update } = useAgentMutations(agent.agent_id)
  const flows = useOtherFlows(agent, current, true)
  const [chosen, setChosen] = useState<WorkflowSummary | null>(null)
  const [notice, setNotice] = useState('')
  if (flows.length === 0) return null
  const confirm = () => {
    if (chosen === null) return
    update.mutate({ workflow_id: chosen.workflow_id }, {
      onSuccess: () => { setNotice(t('editor.switched', { name: chosen.name })); setChosen(null) },
      onError: () => { setChosen(null) },
    })
  }
  return (
    <>
      <RowActionsMenu label={t('detail.flow.another')} className="btn btn-secondary btn-sm"
        face={<>{t('detail.flow.another')} <ChevronDown size={14} aria-hidden="true" /></>}
        entries={flows.map((flow) => ({ kind: 'action', id: flow.workflow_id, label: flow.name, icon: Workflow, onSelect: () => { setNotice(''); update.reset(); setChosen(flow) } }))} />
      {notice !== '' && <p role="status" className="w-full text-[12px] text-ok">{notice}</p>}
      {update.isError && <p role="alert" className="w-full text-[12px] text-danger">{t('editor.switchFailed')}</p>}
      <ConfirmModal isOpen={chosen !== null} title={t('editor.switchTitle')}
        message={t('detail.flow.switchMessage', { name: agent.name, flow: chosen?.name ?? '' })}
        confirmLabel={t('editor.switchConfirm')} cancelLabel={t('common.cancel')} variant="warning"
        isLoading={update.isPending} onConfirm={confirm} onCancel={() => setChosen(null)} />
    </>
  )
}

export function AgentFlowTab({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  // (7.52.00 C2: a step clicked, or Enter on it, opens its setup beside the canvas, read only)
  const [selection, setSelection] = useState<FlowSelection>(null)
  const workflowId = agent.workflow_id ?? DEFAULT_WORKFLOW_ID
  // (the cache entry the Runs tab, the run's graph and the flow's page read)
  const read = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId) })
  const workflow = read.data?.workflow
  if (read.isLoading) return <div className="skeleton h-[min(34rem,70vh)]" />
  if (read.isError || workflow === undefined) {
    return <LoadFailed message={t('detail.flow.loadFailed')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
  }
  return (
    <section className="card p-0 overflow-hidden" aria-label={t('detail.tab.flow')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Workflow size={16} className="shrink-0 text-muted" aria-hidden="true" />
        <h2 className="min-w-0 text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{workflow.name}</h2>
        <span className="text-[12px] text-muted tabular-nums">{t('detail.flow.revision', { revision: workflow.revision })}</span>
        <span className="mr-auto" />
        {isAdmin && (
          <>
            <Link to={workflowPath(workflowId)} className="btn btn-secondary btn-sm">
              <PencilRuler size={14} aria-hidden="true" /> {t('detail.flow.edit')}
            </Link>
            <RunAnotherFlow agent={agent} current={workflowId} />
          </>
        )}
      </div>
      <p className="px-4 pt-3 text-[12px] text-muted max-w-prose">{t('detail.flow.readOnly')}</p>
      {workflow.definition === null
        ? <div className="p-4"><Notice variant="empty" icon={Workflow} title={t('detail.flow.unreadableTitle')} text={t('detail.flow.unreadable')} /></div>
        : (
            <div className="flex flex-col lg:flex-row">
              <div className="h-[min(34rem,70vh)] min-h-[18rem] min-w-0 flex-1" data-testid="flow-canvas">
                <FlowCanvas definition={workflow.definition} mode="view" onSelect={setSelection} />
              </div>
              <FlowInspector definition={workflow.definition} mode="view" selection={selection} onClose={() => setSelection(null)}
                workflowId={workflowId} connection={agent.engineering?.connection ?? null}
                editPath={isAdmin ? workflowPath(workflowId) : null} />
            </div>
          )}
    </section>
  )
}
