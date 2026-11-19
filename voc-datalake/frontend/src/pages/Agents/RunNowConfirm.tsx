/**
 * @fileoverview "Run now" asks first: a run calls the AI models and can take
 * many minutes, so the confirmation says what will run — the agent, its
 * workflow, the feedback in its scope and the run's model-call ceiling. An
 * engineering agent's (7.47.00) starts an engineering run on its repository,
 * optionally from an issue (a feature agent needs one: a PRD starts it from
 * the PRD's page), which reruns that issue even when it has started a run,
 * and (7.58.00) on one model for every role of the run, or each role's own
 * (ModelChoiceField.tsx: an other id must have its shape before it starts).
 *
 * @module pages/Agents/RunNowConfirm
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { ScopeSummary } from './AgentBadges'
import { ModelChoiceField } from './ModelChoiceField'
import { modelChoiceOf, draftOf, modelIssue } from './modelChoice'
import { typedIssue } from './startRunRules'
import type { ReactNode } from 'react'
import type { Agent, RunNowBody } from '../../api/agentsApi'

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-strong">{children}</dd>
    </div>
  )
}

/** The issue an engineering agent's run starts from (required for a feature agent). */
function IssueField({ required, value, onChange }: Readonly<{ required: boolean; value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('agents')
  const invalid = typedIssue(value) === undefined
  return (
    <div className="mt-3">
      <LabeledField label={required ? t('run.issueRequired') : t('run.issueOptional')}
        hint={invalid ? t('run.issueInvalid') : t('run.issueHint')} hintTone={invalid ? 'danger' : 'muted'}>
        {(id) => (
          <input id={id} className="input w-full" inputMode="numeric" autoComplete="off" value={value}
            aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.value)} />
        )}
      </LabeledField>
    </div>
  )
}

/** An engineering agent's Run now body: its issue when one was typed, the run's model when one was chosen; none for
 * neither. */
function runNowBody(issue: number | null | undefined, chosen: string | null): RunNowBody | undefined {
  const body: RunNowBody = { ...(typeof issue === 'number' ? { issue } : {}), ...(chosen === null ? {} : { model: chosen }) }
  return Object.keys(body).length > 0 ? body : undefined
}

/** The confirmation's question: an engineering agent's (bug or feature), else the model-call ceiling. */
function useMessage(agent: Agent): string {
  const { t } = useTranslation('agents')
  if (agent.engineering === null) return t('run.confirmMessage', { calls: agent.budget.max_model_calls_per_run })
  return agent.engineering.feedback_type === 'feature_request' ? t('run.engineeringConfirmFeature') : t('run.engineeringConfirmBug')
}

export function RunNowConfirm({ agent, starting, onConfirm, onCancel }: Readonly<{
  agent: Agent; starting: boolean; onConfirm: (body?: RunNowBody) => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const workflowId = agent.workflow_id ?? DEFAULT_WORKFLOW_ID
  const [issueText, setIssueText] = useState('')
  const [model, setModel] = useState(() => draftOf(null))
  // The same cache entry the run detail and the Workflow tab read.
  const { data: workflow, isError } = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId) })
  const message = useMessage(agent)
  const engineering = agent.engineering !== null
  const feature = agent.engineering?.feedback_type === 'feature_request'
  const issue = typedIssue(issueText)
  const blocked = engineering && (issue === undefined || (feature && issue === null) || modelIssue(model) !== null)
  return (
    <ConfirmModal
      isOpen
      title={t('run.confirmTitle')}
      message={message}
      confirmLabel={t('run.confirmStart')}
      cancelLabel={t('common.cancel')}
      variant="info"
      isLoading={starting}
      confirmDisabled={blocked}
      onConfirm={() => onConfirm(engineering ? runNowBody(issue, modelChoiceOf(model)) : undefined)}
      onCancel={onCancel}
    >
      <dl className="mt-3 space-y-1 text-sm">
        <Fact label={t('run.confirmAgent')}>{agent.name}</Fact>
        <Fact label={t('run.confirmWorkflow')}>{workflow?.workflow.name ?? (isError ? workflowId : '…')}</Fact>
        <Fact label={t('run.confirmScope')}><ScopeSummary scope={agent.scope} /></Fact>
      </dl>
      {engineering && <IssueField required={feature} value={issueText} onChange={setIssueText} />}
      {engineering && (
        <div className="mt-3">
          <ModelChoiceField label={t('run.model.label')} defaultLabel={t('run.model.default')} draft={model} onChange={setModel} harness="any"
            disabled={starting} />
        </div>
      )}
    </ConfirmModal>
  )
}
