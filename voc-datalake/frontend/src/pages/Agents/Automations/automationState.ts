/**
 * @fileoverview An automation's one state, its one primary action and its reason (7.52.00 C1; ux-agents-redesign part 1
 * §2.3 "State model"), as a pure table: the list's row, the agent's page header and the setup guide's steps read it.
 * The first rule that matches wins:
 *
 * | # | When | State | Primary |
 * |---|---|---|---|
 * | 1 | engineering, off, no connection it can use | Needs setup | none (the group's Connect GitHub) |
 * | 2 | engineering, off, not set up (a connection, a language, its flow's budget) | Needs setup | Set up |
 * | 3 | engineering, off, set up, a check a run needs does not pass | Needs setup ("N to fix") | Set up |
 * | 4 | engineering, on, not set up any more (its connection was removed) | Can't run | Fix |
 * | 5 | paused (the server's exact state, 7.52.00 `paused`: only an automation that is on is) | Paused | Resume |
 * | 6 | off | Ready ("N warnings" when any) | Enable |
 * | 7 | on | Enabled (a cap's skip as its reason) | Run now |
 * | * | its last run waits for a person (`needs_human`) | unchanged | Review |
 *
 * Its engineering reads (the connections, its flow's budget; its readiness while off) decide rules 1 to 4: while they
 * load the state is `loading`; when they fail it comes from the `enabled` flag alone, `unchecked` (the row says
 * "Couldn't check"; Set up still opens the drawer, which reads again). A person who is not an administrator gets the
 * state and no action.
 *
 * @module pages/Agents/Automations/automationState
 */
import { isBlocking } from '../../../api/engineeringReadinessApi'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { readinessOf } from '../engineeringAgentRules'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'

export type AutomationStateId = 'needs_setup' | 'cant_run' | 'paused' | 'ready' | 'enabled'

/** The one action a row (and the agent's page) offers for its state. */
export type AutomationPrimary = 'set_up' | 'fix' | 'resume' | 'enable' | 'run_now' | 'review'

/** Why, in one line, when the state needs one. */
type AutomationReason = 'connection_gone' | 'monthly_cap' | 'daily_cap'

/**
 * What the engineering rules stand on: the deployment's connections and the flow's monthly budget (dollars; null for
 * none), `ready` once read, `loading` while on their way, `failed` when a read failed (or is not made here).
 */
export interface EngineeringRead {
  readonly state: 'loading' | 'failed' | 'ready'
  readonly connections: readonly EngineeringConnection[]
  readonly budget: number | null
}

export interface AutomationInput {
  readonly agent: Agent
  readonly isAdmin: boolean
  /** The engineering reads (unused for a product automation). */
  readonly engineering: EngineeringRead
  /** Its readiness while it is off (undefined while it loads, or when it was not read or failed). */
  readonly checks: readonly ReadinessCheck[] | undefined
}

export interface AutomationState {
  /** `loading` while the reads it needs are on their way. */
  readonly state: AutomationStateId | 'loading'
  readonly primary: AutomationPrimary | null
  /** The checks a run needs that do not pass ("N to fix"; 0: none, or not read yet). */
  readonly toFix: number
  /** The warnings, said only when nothing is to fix ("1 warning"). */
  readonly warnings: number
  readonly reason: AutomationReason | null
  /** Its last run waits for a person (the override). */
  readonly needsDecision: boolean
  /** Its reads failed: the state is the `enabled` flag's alone. */
  readonly unchecked: boolean
}

/** A cap's skip the heartbeat recorded (heartbeat/handler.py `_skip_reason`). */
const isCapReason = (skip: string | null): skip is 'monthly_cap' | 'daily_cap' => skip === 'monthly_cap' || skip === 'daily_cap'

interface Rule {
  readonly state: AutomationStateId
  readonly primary: AutomationPrimary | null
  readonly reason?: AutomationReason | null
}

/** Rules 5 to 7, every automation's (an engineering one's once its own rules pass). */
function commonRule(agent: Agent): Rule {
  if (agent.enabled && agent.paused) return { state: 'paused', primary: 'resume' }
  if (!agent.enabled) return { state: 'ready', primary: 'enable' }
  const skip = agent.stats.last_skip_reason
  return { state: 'enabled', primary: 'run_now', reason: isCapReason(skip) ? skip : null }
}

/** Rules 1 to 4, an engineering automation's, from its reads; null when they pass. */
function engineeringRule(agent: Agent, facts: EngineeringRead, toFix: number): Rule | null {
  const setUp = readinessOf(agent, facts.connections, facts.budget)
  if (agent.enabled) return setUp === 'ready' ? null : { state: 'cant_run', primary: 'fix', reason: 'connection_gone' }
  if (setUp === 'no_connection') return { state: 'needs_setup', primary: null }
  if (setUp === 'set_up' || toFix > 0) return { state: 'needs_setup', primary: 'set_up' }
  return null
}

/** The rule that matches, and whether the reads it stands on failed (the flag alone then); null while they load. */
function matchingRule({ agent, isAdmin, engineering }: AutomationInput, toFix: number): { rule: Rule; failed: boolean } | null {
  // (a person who is not an administrator reads no engineering facts: the `enabled` flag's state, no action)
  if (!isEngineeringAgent(agent) || !isAdmin) return { rule: commonRule(agent), failed: false }
  if (engineering.state === 'loading') return null
  if (engineering.state === 'ready') return { rule: engineeringRule(agent, engineering, toFix) ?? commonRule(agent), failed: false }
  const rule = commonRule(agent)
  // (Set up still opens the drawer, which reads again)
  return { rule: agent.enabled ? rule : { ...rule, primary: 'set_up' }, failed: true }
}

/** The checks to fix and the warnings of a readiness read while the automation is off. */
function checkCounts(agent: Agent, checks: readonly ReadinessCheck[] | undefined): { toFix: number; warnings: number } {
  if (agent.enabled || checks === undefined) return { toFix: 0, warnings: 0 }
  const toFix = checks.filter(isBlocking).length
  return { toFix, warnings: toFix > 0 ? 0 : checks.filter((check) => check.status === 'warn').length }
}

/** The state, the primary and the reason of an automation (module doc's table). */
export function automationState(input: AutomationInput): AutomationState {
  const { agent, isAdmin, checks } = input
  const needsDecision = agent.stats.last_run_status === 'needs_human'
  const counts = checkCounts(agent, checks)
  const matched = matchingRule(input, counts.toFix)
  const base = { ...counts, needsDecision, unchecked: false, reason: null }
  if (matched === null) return { ...base, state: 'loading', primary: null }
  const { rule, failed } = matched
  const primary = needsDecision ? 'review' : rule.primary
  return {
    ...base,
    state: rule.state,
    primary: isAdmin ? primary : null,
    reason: rule.reason ?? null,
    unchecked: failed,
  }
}

/** Each state's chip tone (state tones only, rule 15; theme/badgeTones). */
export const STATE_TONES: Readonly<Record<AutomationStateId, string>> = {
  needs_setup: 'badge-warn',
  cant_run: 'badge-danger',
  paused: 'badge-muted',
  ready: 'badge-muted',
  enabled: 'badge-ok',
}

/** The automations grouped as the list shows them: engineering first (where action is needed), then product. */
export function groupAutomations(agents: readonly Agent[]): { engineering: Agent[]; product: Agent[] } {
  return {
    engineering: agents.filter((agent) => isEngineeringAgent(agent)),
    product: agents.filter((agent) => !isEngineeringAgent(agent)),
  }
}
