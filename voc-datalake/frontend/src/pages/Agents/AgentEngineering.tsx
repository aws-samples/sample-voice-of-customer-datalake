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
 * Before Enable (7.50.00) the dialog, the agents list's card and the switch show the automation's readiness
 * (`GET /agents/engineering/readiness?automation=<id>`, ReadinessChecks.tsx): each check passed, failed or with a
 * warning, its fix and its doc link. Enable waits while a check a run needs (`required`) does not pass (an advisory
 * check or a warning never holds it), and an Enable the server refuses with 409 `{error, checks}` shows the checks it
 * names. The dialog reads the readiness of its selection (7.50.01: `&connection=<id>&language=<language>`, read again
 * whenever either changes), so the connection's App installation, CI attestation and branch rules, the Issues source
 * and the language's image are those of what it would save; only the budget, which it saves itself, does not hold its
 * Save and enable (the Enable after the save checks it again). The dialog fits the window (`max-h-[90vh]`): its body
 * scrolls between the title and the buttons, which stay in view. A failing way of working (`dial`) offers the person
 * setting it up to set their own to AI-driven there (7.50.02, DialFix.tsx), its readiness read again after.
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
import { agentsPath } from './agentsPaths'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { agentsApi, agentsKeys } from '../../api/agentsApi'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { serverReason } from '../../lib/errors'
import { blocksEnable, engineeringReadinessKeys, failingChecksOf } from '../../api/engineeringReadinessApi'
import { useAgentMutations } from './useAgents'
import { RUN_LANGUAGES } from './startRunRules'
import { readinessOf, usableConnections } from './engineeringAgentRules'
import { FailingChecks, ReadinessSection } from './ReadinessChecks'
import { DialFix } from './DialFix'
import { useReadiness } from './useReadiness'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import type { Readiness } from './engineeringAgentRules'
import type { Agent } from '../../api/agentsApi'
import type { ReadinessCheck, ReadinessSubject } from '../../api/engineeringReadinessApi'
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
      onDone()
    },
    // (an Enable refused after the settings were saved: the agent, its flow and its readiness are read again)
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: agentsKeys.detail(agent.agent_id) })
      void queryClient.invalidateQueries({ queryKey: agentsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.detail(workflow.workflow_id) })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: engineeringReadinessKeys.of({ automation: agent.agent_id }) })
    },
  })
}

/**
 * The check the Set up dialog sets itself and the readiness cannot be asked of: the flow's budget, saved with its form
 * (and checked by the form), is checked again by the Enable after it. The connection and the image are the
 * selection's (the preview).
 */
const SET_BY_THE_DIALOG: ReadonlySet<string> = new Set(['budget'])

/** Whether Enable waits: a check a run needs fails (in the dialog, one it does not set itself). */
function enableHeld(checks: readonly ReadinessCheck[] | undefined, inDialog: boolean): boolean {
  if (checks === undefined) return false
  return blocksEnable(inDialog ? checks.filter((check) => !SET_BY_THE_DIALOG.has(check.id)) : checks)
}

/**
 * Whether Enable waits for the readiness of `subject`, the agent's or (in the dialog) its selection's, read while
 * `enabled` and the agent is disabled: in the dialog also while it loads (its Save would enable before the checks are
 * known); `shown`: the reason is worth a line.
 */
function useEnableHold(agent: Agent, subject: ReadinessSubject, enabled: boolean, inDialog: boolean): {
  held: boolean; shown: boolean
} {
  const readiness = useReadiness(subject, enabled && !agent.enabled)
  if (agent.enabled) return { held: false, shown: false }
  const failing = enableHeld(readiness.data, inDialog)
  return { held: failing || (inDialog && readiness.isLoading), shown: failing }
}

/** The refusal of a set-up or an Enable: the failing checks a 409 names, else the server's words. */
function EnableError({ error, fallback }: Readonly<{ error: unknown; fallback: string }>) {
  const failing = failingChecksOf(error)
  if (failing !== null && failing.length > 0) return <FailingChecks checks={failing} />
  return <p role="alert" className="text-[12px] text-danger">{serverReason(error) ?? fallback}</p>
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
  // (the readiness of the selection: read again whenever the connection or the language changes)
  const selection: ReadinessSubject = { automation: agent.agent_id, connection: form.connection, language: form.language }
  const hold = useEnableHold(agent, selection, true, true)
  // (the same read as the section's: one cache entry)
  const checks = useReadiness(selection, true).data
  const held = hold.held
  const typed = form.budget.trim() !== ''
  const ready = typed && isMonthlyBudgetUsd(Number(form.budget)) && form.connection !== '' && !held
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg max-h-[90vh]"
      dismissable={!save.isPending}>
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
          <ReadinessSection subject={selection} enabled />
          <DialFix subject={selection} checks={checks} />
          {hold.shown && <p className="text-[12px] text-warn">{t('readiness.enableWaits')}</p>}
          {save.isError && <EnableError error={save.error} fallback={t('engineeringAgent.setupFailed')} />}
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

/** Under the switch of a disabled agent: why Enable waits, its readiness folded, and an Enable's refusal. */
function EnableNotes({ agent, isAdmin, held, withReadiness, error }: Readonly<{
  agent: Agent; isAdmin: boolean; held: boolean; withReadiness: boolean; error: unknown
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      {held && <p className="text-[12px] text-warn max-w-xs">{t('readiness.enableWaits')}</p>}
      {withReadiness && isAdmin && !agent.enabled && (
        <div className="max-w-md"><ReadinessSection subject={{ automation: agent.agent_id }} enabled collapsed /></div>
      )}
      {error !== null && <div className="max-w-md"><EnableError error={error} fallback={t('engineeringAgent.enableFailed')} /></div>}
    </>
  )
}

function EnabledSwitch({ agent, isAdmin, onSetUp, withReadiness }: Readonly<{
  agent: Agent; isAdmin: boolean; onSetUp: () => void; withReadiness: boolean
}>) {
  const { t } = useTranslation('agents')
  const { setEnabled } = useAgentMutations(agent.agent_id)
  // (turning it off never waits; turning it on waits for the checks a run needs)
  const { held } = useEnableHold(agent, { automation: agent.agent_id }, isAdmin, false)
  return (
    <div className="flex flex-col items-end gap-1">
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-text">
        <button type="button" role="switch" aria-checked={agent.enabled} disabled={!isAdmin || setEnabled.isPending || held}
          className={clsx('switch', agent.enabled && 'switch-on')} onClick={() => setEnabled.mutate(!agent.enabled)}
          aria-label={t('detail.enabledLabel')}>
          <span className="switch-knob" />
        </button>
        {agent.enabled ? t('status.enabled') : t('status.disabled')}
      </label>
      {isAdmin && (
        <Tooltip kind="label" content={t('engineeringAgent.changeSetup')}>
          <button type="button" className="icon-btn" aria-label={t('engineeringAgent.changeSetup')}
            onClick={onSetUp}>
            <Settings2 size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
    <EnableNotes agent={agent} isAdmin={isAdmin} held={held} withReadiness={withReadiness} error={setEnabled.error} />
    </div>
  )
}

/** In place of the switch while a requirement is missing: what is missing, and the way to it. */
function NotReady({ readiness, isAdmin, onSetUp, badge = true }: Readonly<{
  readiness: Readiness; isAdmin: boolean; onSetUp: () => void; badge?: boolean
}>) {
  const { t } = useTranslation('agents')
  const noConnection = readiness === 'no_connection'
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {badge && <span className="badge badge-muted">{t('status.disabled')}</span>}
        {noConnection && <Link className="btn btn-secondary btn-sm" to={agentsPath({ view: 'connections' })}>{t('engineeringAgent.connectFirst')}</Link>}
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

/**
 * The Set up dialog of `agent`: what opens it, and the dialog while open (once its reads have answered), offering
 * the connections the agent may use.
 */
function useSetUpDialog(agent: Agent, workflow: WorkflowView | undefined, connections: readonly EngineeringConnection[] | undefined) {
  const [open, setOpen] = useState(false)
  const dialog = open && workflow !== undefined && connections !== undefined
    ? <SetupDialog agent={agent} workflow={workflow} connections={usableConnections(agent, connections)} onClose={() => setOpen(false)} />
    : null
  return { openSetUp: () => setOpen(true), dialog }
}

/** The two reads the control stands on: the deployment's connections (an admin's only) and the agent's flow. */
function useEngineeringReads(agent: Agent, isAdmin: boolean) {
  const workflowId = agent.workflow_id ?? ''
  const connectionsQuery = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list,
    enabled: isAdmin })
  const workflowQuery = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId),
    enabled: workflowId !== '' })
  return {
    workflow: workflowQuery.data?.workflow,
    connections: connectionsQuery.data?.connections,
    failed: connectionsQuery.isError || workflowQuery.isError,
  }
}

/**
 * The Enabled control of an engineering agent's page (module doc). `withReadiness` (default on) folds the readiness
 * under the switch of a disabled agent; the setup guide shows it open beside the control instead.
 */
export function EngineeringEnableControl({ agent, isAdmin, withReadiness = true }: Readonly<{
  agent: Agent; isAdmin: boolean; withReadiness?: boolean
}>) {
  const { t } = useTranslation('agents')
  const { workflow, connections, failed } = useEngineeringReads(agent, isAdmin)
  const { openSetUp, dialog } = useSetUpDialog(agent, workflow, connections)
  if (connections === undefined || workflow === undefined) {
    return failed
      ? <p role="alert" className="text-[12px] text-danger">{t('engineeringAgent.loadFailed')}</p>
      : <Loader2 size={16} className="animate-spin text-muted" aria-label={t('engineeringAgent.loading')} />
  }
  const readiness = readinessOf(agent, connections, workflow.monthly_budget_usd)
  const owner = agent.enabled ? agent.owner_username : null
  return (
    <div className="flex flex-col items-end gap-1 text-right" data-testid="engineering-enable">
      {readiness === 'ready'
        ? <EnabledSwitch agent={agent} isAdmin={isAdmin} onSetUp={openSetUp} withReadiness={withReadiness} />
        : <NotReady readiness={readiness} isAdmin={isAdmin} onSetUp={openSetUp} />}
      {owner !== null && <p className="text-[12px] text-muted max-w-xs">{t('engineeringAgent.runsAs', { name: owner })}</p>}
      <p className="text-[12px] text-muted max-w-xs">{t('engineeringAgent.deploymentFeedback')}</p>
      {dialog}
    </div>
  )
}

/**
 * The agents list's card of an engineering agent that is not set up (7.49.00), for an admin: the page's **Set up**
 * (the same dialog) or **Connect a repository first**, with the reason, and while it is disabled its readiness folded
 * under its summary (7.50.00). A set-up agent that is disabled keeps the card while a check a run needs fails (its
 * Set up opens the dialog whose Enable waits for it). Nothing once the agent is enabled, or set up with nothing failing
 * (the row's badge says Enabled or Disabled), while its reads load, or when they fail (its page says so). The dialog
 * starts its text from the start whatever wrapper it sits in (ModalShell `text-start`).
 */
export function EngineeringSetUpCard({ agent }: Readonly<{ agent: Agent }>) {
  const { t } = useTranslation('agents')
  const { workflow, connections } = useEngineeringReads(agent, true)
  const { openSetUp, dialog } = useSetUpDialog(agent, workflow, connections)
  // (the readiness before Enable: 7.50.00; nothing once the agent is enabled)
  const checks = useReadiness({ automation: agent.agent_id }, !agent.enabled)
  if (connections === undefined || workflow === undefined) return null
  const readiness = readinessOf(agent, connections, workflow.monthly_budget_usd)
  const failing = !agent.enabled && blocksEnable(checks.data ?? [])
  if (readiness === 'ready' && !failing) return null
  return (
    <div className="flex flex-col items-start gap-1" data-testid="engineering-setup-card">
      {/* No state badge: the row beside it shows the agent's (an enabled agent whose connection went is not set up). */}
      {readiness === 'ready'
        ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={openSetUp}>{t('engineeringAgent.setUp')}</button>
            <p className="text-[12px] text-muted max-w-xs">{t('readiness.enableWaits')}</p>
          </div>
        )
        : <NotReady readiness={readiness} isAdmin badge={false} onSetUp={openSetUp} />}
      {!agent.enabled && <div className="w-full max-w-xl"><ReadinessSection subject={{ automation: agent.agent_id }} enabled collapsed /></div>}
      {dialog}
    </div>
  )
}
