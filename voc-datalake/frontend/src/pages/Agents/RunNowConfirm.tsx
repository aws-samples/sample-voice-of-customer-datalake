/**
 * @fileoverview "Run now" asks first: a run calls the AI models and can take
 * many minutes, so the confirmation says what will run — the agent, its
 * workflow, the feedback in its scope and the run's model-call ceiling.
 *
 * @module pages/Agents/RunNowConfirm
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { ScopeSummary } from './AgentBadges'
import type { ReactNode } from 'react'
import type { Agent } from '../../api/agentsApi'

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-strong">{children}</dd>
    </div>
  )
}

export function RunNowConfirm({ agent, starting, onConfirm, onCancel }: Readonly<{
  agent: Agent; starting: boolean; onConfirm: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const workflowId = agent.workflow_id ?? DEFAULT_WORKFLOW_ID
  // The same cache entry the run detail and the Workflow tab read.
  const { data: workflow, isError } = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId) })
  return (
    <ConfirmModal
      isOpen
      title={t('run.confirmTitle')}
      message={t('run.confirmMessage', { calls: agent.budget.max_model_calls_per_run })}
      confirmLabel={t('run.confirmStart')}
      cancelLabel={t('common.cancel')}
      variant="info"
      isLoading={starting}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <dl className="mt-3 space-y-1 text-sm">
        <Fact label={t('run.confirmAgent')}>{agent.name}</Fact>
        <Fact label={t('run.confirmWorkflow')}>{workflow?.workflow.name ?? (isError ? workflowId : '…')}</Fact>
        <Fact label={t('run.confirmScope')}><ScopeSummary scope={agent.scope} /></Fact>
      </dl>
    </ConfirmModal>
  )
}
