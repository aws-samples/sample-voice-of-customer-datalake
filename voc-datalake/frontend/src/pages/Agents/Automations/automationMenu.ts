/**
 * @fileoverview The items of an automation's ⋯ menu (7.52.00 C1; ux-agents-redesign part 1 §2.3, part 2 S6), by its state
 * and where it is shown:
 *
 * - **the list's row:** Open · Edit settings · Change setup… (engineering, once set up) · Rename… · Pause (on) or
 *   Resume (paused) · Turn off (on) · Run now (when it is not the row's primary) · All runs (an engineering
 *   automation's flow, on Runs) · then **Delete…** in the danger tone;
 * - **its page:** Pause or Resume · Turn off · Run now (when not the header's primary) · Change setup… · Rename… · then
 *   **Archive…**.
 *
 * An item the state does not offer is left out, never shown disabled. Delete and Archive are last, after a line.
 *
 * @module pages/Agents/Automations/automationMenu
 */
import { CirclePause, ExternalLink, History, Pencil, Play, Power, Settings2, Trash2, Wrench, Archive } from 'lucide-react'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { agentPath } from '../agentsPaths'
import { flowRunsPath } from '../workflowPaths'
import type { TFunction } from 'i18next'
import type { Agent } from '../../../api/agentsApi'
import type { RowMenuAction, RowMenuEntry } from '../../../components/RowActionsMenu/rowMenuEntries'
import type { AutomationState } from './automationState'
import type { AutomationActions } from './useAutomationActions'

interface MenuInput {
  readonly agent: Agent
  readonly state: AutomationState
  readonly actions: AutomationActions
  readonly t: TFunction<'agents'>
  /** Opens an address of the app (the router's navigate). */
  readonly go: (path: string) => void
}

const SEPARATOR: RowMenuEntry = { kind: 'separator', id: 'separator' }

/** The state's own items: Pause or Resume, Turn off, Run now (when the primary is not Run now). */
function stateItems({ agent, state, actions, t }: MenuInput): RowMenuAction[] {
  const items: RowMenuAction[] = []
  if (agent.enabled && !agent.paused) items.push({ kind: 'action', id: 'pause', label: t('automations.menu.pause'), icon: CirclePause, onSelect: actions.pause })
  if (agent.enabled && agent.paused) items.push({ kind: 'action', id: 'resume', label: t('automations.menu.resume'), icon: Play, onSelect: actions.resume })
  if (agent.enabled) items.push({ kind: 'action', id: 'turnOff', label: t('automations.menu.turnOff'), icon: Power, onSelect: actions.turnOff })
  const runnable = state.state === 'enabled' || state.state === 'paused' || state.state === 'ready'
  if (runnable && state.primary !== 'run_now') {
    items.push({ kind: 'action', id: 'runNow', label: t('automations.menu.runNow'), icon: Play, onSelect: actions.runNow })
  }
  return items
}

/** Change setup…, an engineering automation's once it is set up (before that, Set up is its primary). */
function setupItem({ agent, state, actions, t }: MenuInput): RowMenuAction[] {
  if (!isEngineeringAgent(agent) || state.state === 'needs_setup' || state.state === 'loading') return []
  return [{ kind: 'action', id: 'changeSetup', label: t('automations.menu.changeSetup'), icon: Wrench, onSelect: () => actions.openSetup('fields') }]
}

/** The list row's menu (module doc). */
export function rowMenuEntries(input: MenuInput): RowMenuEntry[] {
  const { agent, actions, t, go } = input
  const workflowId = agent.workflow_id
  const allRuns: RowMenuAction[] = isEngineeringAgent(agent) && workflowId !== null
    ? [{ kind: 'action', id: 'allRuns', label: t('automations.menu.allRuns'), icon: History, onSelect: () => go(flowRunsPath(workflowId)) }]
    : []
  return [
    { kind: 'action', id: 'open', label: t('automations.menu.open'), icon: ExternalLink, onSelect: () => go(agentPath(agent.agent_id)) },
    { kind: 'action', id: 'settings', label: t('automations.menu.editSettings'), icon: Settings2, onSelect: () => go(agentPath(agent.agent_id, 'settings')) },
    ...setupItem(input),
    { kind: 'action', id: 'rename', label: t('automations.menu.rename'), icon: Pencil, onSelect: actions.rename },
    SEPARATOR,
    ...stateItems(input),
    ...allRuns,
    { ...SEPARATOR, id: 'separator-danger' },
    { kind: 'action', id: 'delete', label: t('automations.menu.delete'), icon: Trash2, danger: true, onSelect: actions.remove },
  ]
}

/** The automation page's header menu (module doc). */
export function pageMenuEntries(input: MenuInput): RowMenuEntry[] {
  const { actions, t } = input
  return [
    ...stateItems(input),
    ...setupItem(input),
    { kind: 'action', id: 'rename', label: t('automations.menu.rename'), icon: Pencil, onSelect: actions.rename },
    SEPARATOR,
    { kind: 'action', id: 'archive', label: t('automations.menu.archive'), icon: Archive, danger: true, onSelect: actions.remove },
  ]
}
