/**
 * @fileoverview The agent's Workflow tab: the editor on the agent's workflow,
 * titled by a switcher (admins) that points the agent at another library
 * workflow — asking first when the editor holds unsaved changes — or by the
 * workflow's name (everyone else).
 *
 * "Save as" re-points the agent at the copy, and the editor is keyed by the
 * workflow it shows, so it remounts on the copy (with no unsaved changes) at
 * once instead of keeping the old workflow's draft — whose Save would have
 * overwritten the OLD workflow. A failed re-point goes back to the agent's own
 * workflow and says so; the copy stays in the library.
 *
 * @module pages/Agents/AgentWorkflow
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { WorkflowEditor } from '../../components/WorkflowEditor/WorkflowEditor'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { useAgentMutations } from './useAgents'
import type { Agent } from '../../api/agentsApi'
import type { WorkflowSummary, WorkflowView } from '../../api/workflowsApi'

interface SwitcherProps {
  currentId: string
  isAdmin: boolean
  /** The editor's draft has unsaved changes (they are lost on a switch). */
  dirty: boolean
  /** The draft's name, for the confirmation. */
  name: string
  onSwitch: (workflow: WorkflowSummary) => void
}

function WorkflowSwitcher({ currentId, isAdmin, dirty, name, onSwitch }: Readonly<SwitcherProps>) {
  const { t } = useTranslation('agents')
  const { data: workflows = [] } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, enabled: isAdmin })
  const [pending, setPending] = useState<WorkflowSummary | null>(null)
  const pick = (workflowId: string) => {
    const chosen = workflows.find((w) => w.workflow_id === workflowId)
    if (chosen === undefined || chosen.workflow_id === currentId) return
    if (dirty) setPending(chosen)
    else onSwitch(chosen)
  }
  const listed = workflows.some((w) => w.workflow_id === currentId)
  const selectId = useId()
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {isAdmin ? (
        <>
          <label htmlFor={selectId} className="sr-only">{t('editor.switchLabel')}</label>
          <select id={selectId} className="select select-sm w-auto min-w-0 max-w-[18rem] truncate font-semibold text-text-strong"
            title={name} value={currentId} onChange={(e) => pick(e.target.value)}>
            {!listed && <option value={currentId}>{name}</option>}
            {workflows.map((w) => <option key={w.workflow_id} value={w.workflow_id}>{w.name}</option>)}
          </select>
        </>
      ) : (
        <p className="truncate text-sm font-semibold text-text-strong" title={name}>{name}</p>
      )}
      <ConfirmModal
        isOpen={pending !== null}
        title={t('editor.switchTitle')}
        message={t('editor.switchMessage', { name })}
        confirmLabel={t('editor.switchConfirm')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={() => {
          if (pending !== null) onSwitch(pending)
          setPending(null)
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}

export function AgentWorkflow({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const { update } = useAgentMutations(agent.agent_id)
  const [copy, setCopy] = useState<WorkflowView | null>(null)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<'savedAs' | 'switch' | null>(null)
  const workflowId = copy?.workflow_id ?? agent.workflow_id ?? DEFAULT_WORKFLOW_ID
  const repoint = (workflow: Pick<WorkflowSummary, 'workflow_id' | 'name'>, kind: 'savedAs' | 'switch', onError?: () => void) => {
    setNotice(undefined)
    setFailure(null)
    update.mutate({ workflow_id: workflow.workflow_id }, {
      onSuccess: () => setNotice(t(kind === 'savedAs' ? 'editor.savedAsAgent' : 'editor.switched', { name: workflow.name })),
      onError: () => {
        onError?.()
        setFailure(kind)
      },
    })
  }
  const onSavedAs = (workflow: WorkflowView) => {
    setCopy(workflow)
    repoint(workflow, 'savedAs', () => setCopy(null))
  }
  const onSwitch = (workflow: WorkflowSummary) => {
    setCopy(null)
    repoint(workflow, 'switch')
  }
  return (
    <div className="space-y-2">
      {failure === 'savedAs' && <p role="alert" className="text-[12px] text-danger">{t('editor.savedAsSwitchFailed')}</p>}
      {failure === 'switch' && <p role="alert" className="text-[12px] text-danger">{t('editor.switchFailed')}</p>}
      <WorkflowEditor key={workflowId} workflowId={workflowId} canEdit={isAdmin} onSavedAs={onSavedAs} notice={notice}
        renderTitle={({ dirty, name }) => (
          <WorkflowSwitcher currentId={workflowId} isAdmin={isAdmin} dirty={dirty} name={name} onSwitch={onSwitch} />
        )} />
    </div>
  )
}
