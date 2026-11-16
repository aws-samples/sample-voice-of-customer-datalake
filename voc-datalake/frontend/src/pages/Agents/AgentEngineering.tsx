/**
 * @fileoverview An engineering agent's Enabled control (7.47.00, docs/autonomous-agents.md "Engineering agents"). An
 * engineering agent runs its engineering flow on a stored repository connection, as the administrator who enabled
 * it, on the deployment's own feedback (only deployment-wide feedback starts its runs). It is enabled only once it is
 * set up (engineeringAgentRules.ts), so in place of the bare switch the card says what is missing:
 *
 * - **Connect a repository first** (a link to Agents → Connections) while the deployment has no connection it can use
 *   (a GitHub one, when it has a GitHub issue trigger);
 * - **Set up**: pick the connection and the repository's language, check the flow's monthly budget (prefilled from the
 *   flow: a seeded flow has one), then Enable: the budget saved as a new revision of the flow only when it was changed
 *   (`PUT /workflows/{id}`), the agent's settings (`PUT /agents/{id}` `{engineering}`), then
 *   `POST /agents/{id}/enable`; the server's refusal is shown in its words.
 *
 * Once set up, the switch as for any agent, with who it runs as and a way back to the set-up.
 *
 * @module pages/Agents/AgentEngineering
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Settings2 } from 'lucide-react'
import clsx from 'clsx'
import { ENGINEERING_MAX_MONTHLY_BUDGET_USD, isMonthlyBudgetUsd } from '@stream/assistant/tools/agent-limits'
import ModalShell from '../../components/ModalShell/ModalShell'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { agentsApi, agentsKeys } from '../../api/agentsApi'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { serverReason } from '../../lib/errors'
import { useAgentMutations } from './useAgents'
import { RUN_LANGUAGES } from './startRunRules'
import { readinessOf, usableConnections } from './engineeringAgentRules'
import type { Readiness } from './engineeringAgentRules'
import type { Agent } from '../../api/agentsApi'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { WorkflowView } from '../../api/workflowsApi'

interface SetupForm {
  connection: string
  language: string
  budget: string
}

/** The set-up's three writes: the flow's budget (only when changed), the agent's settings, then its enable. */
function useSetup(agent: Agent, workflow: WorkflowView, onDone: () => void) {
  const queryClient = useQueryClient()
  const stored = workflow.definition?.budget?.monthly_usd
  return useMutation({
    mutationFn: async (form: SetupForm) => {
      const amount = Number(form.budget)
      if (workflow.definition !== null && amount !== stored) {
        await workflowsApi.save(workflow.workflow_id, { ...workflow.definition, budget: { monthly_usd: amount } }, workflow.revision)
      }
      const updated = await agentsApi.update(agent.agent_id, {
        engineering: { connection: form.connection, language: form.language, feedback_type: agent.engineering?.feedback_type ?? 'bug' },
      })
      return agent.enabled ? updated : agentsApi.enable(agent.agent_id)
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(agentsKeys.detail(agent.agent_id), saved)
      void queryClient.invalidateQueries({ queryKey: agentsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.detail(workflow.workflow_id) })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.list() })
      onDone()
    },
  })
}

function SetupFields({ form, connections, budgetIssue, onChange }: Readonly<{
  form: SetupForm; connections: readonly EngineeringConnection[]; budgetIssue: boolean
  onChange: (field: keyof SetupForm, value: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <LabeledField label={t('engineeringAgent.connection')} hint={t('engineeringAgent.connectionHint')}>
        {(id) => (
          <select id={id} className="select w-full" value={form.connection} onChange={(e) => onChange('connection', e.target.value)}>
            {connections.map((connection) => (
              <option key={connection.connection_id} value={connection.connection_id}>
                {connection.connection_id} · {connection.repository}
              </option>
            ))}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t('engineeringAgent.language')} hint={t('startRun.hints.language')}>
        {(id) => (
          <select id={id} className="select w-full" value={form.language} onChange={(e) => onChange('language', e.target.value)}>
            {RUN_LANGUAGES.map((language) => <option key={language} value={language}>{t(`startRun.languages.${language}`)}</option>)}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t('engineeringAgent.budget')}
        hint={budgetIssue ? t('engineeringAgent.budgetInvalid') : t('engineeringAgent.budgetHint')}
        hintTone={budgetIssue ? 'danger' : 'muted'}>
        {(id) => (
          <input id={id} type="number" inputMode="decimal" min={0.01} step={0.01} max={ENGINEERING_MAX_MONTHLY_BUDGET_USD}
            className="input w-full" value={form.budget} aria-invalid={budgetIssue || undefined} aria-describedby={`${id}-hint`}
            onChange={(e) => onChange('budget', e.target.value)} />
        )}
      </LabeledField>
    </>
  )
}

function SetupDialog({ agent, workflow, connections, onClose }: Readonly<{
  agent: Agent; workflow: WorkflowView; connections: readonly EngineeringConnection[]; onClose: () => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const stored = workflow.definition?.budget?.monthly_usd
  const [form, setForm] = useState<SetupForm>(() => ({
    connection: agent.engineering?.connection ?? connections.at(0)?.connection_id ?? '',
    language: agent.engineering?.language ?? 'python',
    budget: stored === undefined ? '' : String(stored),
  }))
  const save = useSetup(agent, workflow, onClose)
  const typed = form.budget.trim() !== ''
  const ready = typed && isMonthlyBudgetUsd(Number(form.budget)) && form.connection !== ''
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg" dismissable={!save.isPending}>
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">{t('engineeringAgent.setupTitle', { name: agent.name })}</h2>
          <p className="dialog-description">{t('engineeringAgent.setupDescription')}</p>
        </div>
      </div>
      <form className="contents" noValidate onSubmit={(event) => {
        event.preventDefault()
        if (ready && !save.isPending) save.mutate(form)
      }}>
        <div className="dialog-body space-y-3">
          <SetupFields form={form} connections={connections} budgetIssue={typed && !isMonthlyBudgetUsd(Number(form.budget))}
            onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))} />
          <p className="text-[12px] text-muted">{t('engineeringAgent.deploymentFeedback')}</p>
          {save.isError && (
            <p role="alert" className="text-[12px] text-danger">{serverReason(save.error) ?? t('engineeringAgent.setupFailed')}</p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || save.isPending}>
            {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {agent.enabled ? t('engineeringAgent.save') : t('engineeringAgent.saveAndEnable')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function EnabledSwitch({ agent, isAdmin, onSetUp }: Readonly<{ agent: Agent; isAdmin: boolean; onSetUp: () => void }>) {
  const { t } = useTranslation('agents')
  const { setEnabled } = useAgentMutations(agent.agent_id)
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-text">
        <button type="button" role="switch" aria-checked={agent.enabled} disabled={!isAdmin || setEnabled.isPending}
          className={clsx('switch', agent.enabled && 'switch-on')} onClick={() => setEnabled.mutate(!agent.enabled)}
          aria-label={t('detail.enabledLabel')}>
          <span className="switch-knob" />
        </button>
        {agent.enabled ? t('status.enabled') : t('status.disabled')}
      </label>
      {isAdmin && (
        <button type="button" className="icon-btn" aria-label={t('engineeringAgent.changeSetup')}
          title={t('engineeringAgent.changeSetup')} onClick={onSetUp}>
          <Settings2 size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** In place of the switch while a requirement is missing: what is missing, and the way to it. */
function NotReady({ readiness, isAdmin, onSetUp }: Readonly<{ readiness: Readiness; isAdmin: boolean; onSetUp: () => void }>) {
  const { t } = useTranslation('agents')
  const noConnection = readiness === 'no_connection'
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="badge badge-muted">{t('status.disabled')}</span>
        {noConnection && <Link className="btn btn-secondary btn-sm" to="/agents?tab=connections">{t('engineeringAgent.connectFirst')}</Link>}
        {!noConnection && isAdmin && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onSetUp}>{t('engineeringAgent.setUp')}</button>
        )}
      </div>
      <p className="text-[12px] text-muted max-w-xs">
        {noConnection ? t('engineeringAgent.whyNoConnection') : t('engineeringAgent.whySetUp')}
      </p>
    </>
  )
}

/** The Enabled control of an engineering agent's page (module doc). */
export function EngineeringEnableControl({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const [setting, setSetting] = useState(false)
  const workflowId = agent.workflow_id ?? ''
  const connectionsQuery = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list,
    enabled: isAdmin })
  const workflowQuery = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId),
    enabled: workflowId !== '' })
  const workflow = workflowQuery.data?.workflow
  const connections = connectionsQuery.data?.connections
  if (connections === undefined || workflow === undefined) {
    const failed = connectionsQuery.isError || workflowQuery.isError
    return failed
      ? <p role="alert" className="text-[12px] text-danger">{t('engineeringAgent.loadFailed')}</p>
      : <Loader2 size={16} className="animate-spin text-muted" aria-label={t('engineeringAgent.loading')} />
  }
  const readiness = readinessOf(agent, connections, workflow.monthly_budget_usd)
  const owner = agent.enabled ? agent.owner_username : null
  return (
    <div className="flex flex-col items-end gap-1 text-right" data-testid="engineering-enable">
      {readiness === 'ready'
        ? <EnabledSwitch agent={agent} isAdmin={isAdmin} onSetUp={() => setSetting(true)} />
        : <NotReady readiness={readiness} isAdmin={isAdmin} onSetUp={() => setSetting(true)} />}
      {owner !== null && <p className="text-[12px] text-muted max-w-xs">{t('engineeringAgent.runsAs', { name: owner })}</p>}
      <p className="text-[12px] text-muted max-w-xs">{t('engineeringAgent.deploymentFeedback')}</p>
      {setting && (
        <SetupDialog agent={agent} workflow={workflow} connections={usableConnections(agent, connections)}
          onClose={() => setSetting(false)} />
      )}
    </div>
  )
}
