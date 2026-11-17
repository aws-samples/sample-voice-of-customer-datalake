/**
 * @fileoverview The Set up drawer's form (SetupDrawer.tsx; 7.52.00 C1): its reads (the automation's flow, whose budget it
 * saves, and the connections it may use), the form started from them once they answered, the readiness of its
 * selection and how many checks hold Enable for it (the budget, which the drawer saves itself, never does), and the
 * set-up's writes: the flow's budget only when changed (a new revision), the automation's settings, then its Enable when
 * nothing holds it.
 *
 * @module pages/Agents/Automations/useSetupDrawerForm
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isMonthlyBudgetUsd } from '@stream/assistant/tools/agent-limits'
import { agentsApi, agentsKeys } from '../../../api/agentsApi'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../../api/engineeringConnectionsApi'
import { blocksEnable, engineeringReadinessKeys, isBlocking } from '../../../api/engineeringReadinessApi'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { usableConnections } from '../engineeringAgentRules'
import { useReadiness } from '../useReadiness'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { ReadinessSubject } from '../../../api/engineeringReadinessApi'
import type { WorkflowView } from '../../../api/workflowsApi'

export interface SetupForm {
  readonly connection: string
  readonly language: string
  readonly budget: string
}

/** The checks the drawer sets itself (the flow's budget, saved with its form): never a reason for Enable to wait. */
const SET_BY_THE_DRAWER: ReadonlySet<string> = new Set(['budget'])

interface SaveRequest {
  readonly form: SetupForm
  readonly workflow: WorkflowView
  readonly enable: boolean
}

/** The set-up's writes: the flow's budget (only when changed), the automation's settings, then its Enable if asked. */
function useSetupSave(agent: Agent) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ form, workflow, enable }: SaveRequest) => {
      const amount = Number(form.budget)
      if (workflow.definition !== null && amount !== workflow.definition.budget?.monthly_usd) {
        await workflowsApi.save(workflow.workflow_id, { ...workflow.definition, budget: { monthly_usd: amount } }, workflow.revision)
      }
      const updated = await agentsApi.update(agent.agent_id, {
        engineering: { connection: form.connection, language: form.language, feedback_type: agent.engineering?.feedback_type ?? 'bug' },
      })
      return enable ? agentsApi.enable(agent.agent_id) : updated
    },
    onSuccess: (saved) => { queryClient.setQueryData(agentsKeys.detail(agent.agent_id), saved) },
    // (an Enable refused after the settings were saved: the automation, its flow and its readiness are read again)
    onSettled: (_saved, _error, { workflow }) => {
      void queryClient.invalidateQueries({ queryKey: agentsKeys.detail(agent.agent_id) })
      void queryClient.invalidateQueries({ queryKey: agentsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.detail(workflow.workflow_id) })
      void queryClient.invalidateQueries({ queryKey: workflowsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: engineeringReadinessKeys.of({ automation: agent.agent_id }) })
    },
  })
}

/** How many checks hold Enable for the selection (none for an automation on; null while its readiness loads). */
function useHeldBy(agent: Agent, subject: ReadinessSubject): number | null {
  const read = useReadiness(subject, !agent.enabled)
  if (agent.enabled) return 0
  if (read.isError) return 0
  if (read.data === undefined) return null
  const holding = read.data.filter((check) => !SET_BY_THE_DRAWER.has(check.id))
  return blocksEnable(holding) ? holding.filter(isBlocking).length : 0
}

/** The drawer's reads: its flow (the budget it saves) and the connections it may use. */
function useDrawerReads(agent: Agent) {
  const workflowId = agent.workflow_id ?? ''
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list })
  const workflow = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId), enabled: workflowId !== '' })
  const usable = connections.data === undefined ? undefined : usableConnections(agent, connections.data.connections)
  return { workflow: workflow.data?.workflow, connections: usable, failed: connections.isError || workflow.isError }
}

function initialForm(agent: Agent, workflow: WorkflowView, connections: readonly EngineeringConnection[]): SetupForm {
  const stored = workflow.definition?.budget?.monthly_usd
  return {
    connection: agent.engineering?.connection ?? connections.at(0)?.connection_id ?? '',
    language: agent.engineering?.language ?? 'python',
    budget: stored === undefined ? '' : String(stored),
  }
}

/** Whether the form can be saved, and whether its budget is off its rule (dollars and cents, at most the cap). */
function checkForm(form: SetupForm | null): { readonly valid: boolean; readonly budgetIssue: boolean } {
  if (form === null || form.budget.trim() === '') return { valid: false, budgetIssue: false }
  const budgetIssue = !isMonthlyBudgetUsd(Number(form.budget))
  return { valid: !budgetIssue && form.connection !== '', budgetIssue }
}

/** The drawer's form (module doc); `onSaved` after a save the server accepted, with whether it enabled. */
export function useSetupDrawerForm(agent: Agent, onSaved: (saved: Agent, enabled: boolean) => void) {
  const { workflow, connections, failed } = useDrawerReads(agent)
  const [form, setForm] = useState<SetupForm | null>(null)
  // (the form starts from the reads once they answered: derived once, then the person's)
  if (form === null && workflow !== undefined && connections !== undefined) setForm(initialForm(agent, workflow, connections))
  const save = useSetupSave(agent)
  const subject = { automation: agent.agent_id, connection: form?.connection ?? '', language: form?.language ?? '' }
  const heldBy = useHeldBy(agent, subject)
  const { valid, budgetIssue } = checkForm(form)
  const enable = !agent.enabled && heldBy === 0
  const submit = () => {
    if (form === null || !valid || save.isPending || workflow === undefined) return
    save.mutate({ form, workflow, enable }, { onSuccess: (saved) => { onSaved(saved, enable) } })
  }
  const change = (field: keyof SetupForm, value: string) => {
    setForm((current) => (current === null ? current : { ...current, [field]: value }))
  }
  return { form, connections, failed, save, subject, heldBy, valid, budgetIssue, enable, submit, change }
}
