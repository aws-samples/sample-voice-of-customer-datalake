/**
 * @fileoverview The setup guide's rules (7.50.00, docs/autonomous-agents.md "Setup guide"): what the deployment has set
 * up, read from the answers of the routes that already serve it (the agents, the repository connections, the GitHub
 * Apps, each automation's readiness), and what a person chose (api/engineeringSetupApi.ts: a step skipped for now, the
 * guide finished, the first visit's choice). Pure, so every rule is tested on its own (setupGuideRules.test.ts).
 *
 * The order is the owner's recommendation (understand → tenets → triage → bug → feature, after the prerequisites):
 * each step builds on what the one before leaves (a repository the agents understand, tenets they judge by, issues
 * triaged before they are fixed or built). It is never a lock: any step can be skipped for now, and a step skipped
 * says what skipping costs. What gates Enable is the readiness a run truly needs (the server's readiness checks, item
 * B of 7.50.00), never this order.
 *
 * @module pages/Agents/SetupGuide/setupGuideRules
 */
import { isCiAttested } from '../../../api/engineeringConnectionsApi'
import { SETUP_STEP_IDS } from '../../../api/engineeringSetupApi'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { SetupProgress, SetupStepId } from '../../../api/engineeringSetupApi'

/** The guide's steps, in the order it recommends them. */
export const GUIDE_STEPS: readonly SetupStepId[] = SETUP_STEP_IDS

/** The steps whose flows arrive in 7.52 (Understand the repository, Tenets): shown, skippable, never done before then. */
const LATER_STEPS: ReadonlySet<SetupStepId> = new Set<SetupStepId>(['understand', 'tenets'])

/** The steps that each set up one of the seeded engineering automations. */
const AUTOMATION_STEPS = ['triage', 'bug_fixer', 'feature_builder'] as const
export type AutomationStep = (typeof AUTOMATION_STEPS)[number]

export const isAutomationStep = (step: SetupStepId): step is AutomationStep =>
  AUTOMATION_STEPS.some((automation) => automation === step)

/**
 * The seeded automations' names (lambda/shared/agent_seed.py; the Issue triage seed is 7.50.00's). The guide finds
 * each by its name first, then a renamed Bug fixer or Feature builder by what it works on; a renamed Issue triage is
 * not found until the agents API names an agent's seed.
 */
const SEEDED_NAMES: Readonly<Record<AutomationStep, string>> = {
  triage: 'issue triage', bug_fixer: 'bug fixer', feature_builder: 'feature builder',
}

/**
 * The checks of an automation's readiness that the prerequisites step covers: the repository's connection through
 * the deployment's GitHub App, its CI attestation and branch protection, and the GitHub Issues source with its label.
 */
const PREREQUISITE_CHECKS: ReadonlySet<string> = new Set([
  'connection', 'app_installation', 'ci_attestation', 'ci_protection', 'issues_source', 'issue_label',
])

export type Automations = Readonly<Record<AutomationStep, Agent | null>>

/** What the guide read of the deployment. */
export interface GuideFacts {
  readonly agents: readonly Agent[]
  readonly connections: readonly EngineeringConnection[]
  /** How many GitHub Apps the deployment has made (Agents → Connections → Connect GitHub). */
  readonly apps: number
  /** Each automation's readiness checks, once read (an automation not found, or not read yet, has none). */
  readonly readiness: Readonly<Partial<Record<AutomationStep, readonly ReadinessCheck[]>>>
}

/** Where a step stands: done (found set up, or the guide finished), skipped for now, to do, or arriving later. */
export type StepStatus = 'done' | 'skipped' | 'todo' | 'later'

const nameOf = (agent: Agent): string => agent.name.trim().toLowerCase()

/** The seeded engineering automations among `agents` (active engineering agents only), each or null. */
export function findAutomations(agents: readonly Agent[]): Automations {
  const engineering = agents.filter((agent) => agent.engineering !== null && agent.status === 'active')
  const named = (step: AutomationStep) => engineering.find((agent) => nameOf(agent) === SEEDED_NAMES[step]) ?? null
  const triage = named('triage')
  const others = engineering.filter((agent) => agent !== triage)
  const working = (type: 'bug' | 'feature_request') => others.find((agent) => agent.engineering?.feedback_type === type) ?? null
  return {
    triage,
    bug_fixer: named('bug_fixer') ?? working('bug'),
    feature_builder: named('feature_builder') ?? working('feature_request'),
  }
}

/** A GitHub connection made through a GitHub App (the 7.45 two clicks, or an App's ids pasted). */
export const throughApp = (connection: EngineeringConnection): boolean =>
  connection.host === 'github' && (connection.credential.kind === 'app' || connection.credential.kind === 'app_reference')

const STATUS_RANK: Readonly<Record<ReadinessCheck['status'], number>> = { fail: 3, unknown: 2, warn: 1, pass: 0 }

/**
 * The prerequisite checks of every readiness read so far, one per check id: the worst answer any automation got (a
 * fail over an unknown over a warning over a pass), the first one read among equals.
 */
export function prerequisiteChecks(facts: Pick<GuideFacts, 'readiness'>): ReadinessCheck[] {
  const worst = new Map<string, ReadinessCheck>()
  for (const check of AUTOMATION_STEPS.flatMap((step) => facts.readiness[step] ?? [])) {
    const kept = worst.get(check.id)
    if (PREREQUISITE_CHECKS.has(check.id) && (kept === undefined || STATUS_RANK[check.status] > STATUS_RANK[kept.status])) {
      worst.set(check.id, check)
    }
  }
  return [...worst.values()]
}

/**
 * The prerequisites are met once GitHub is connected through an App, a connection's CI is attested, and no
 * prerequisite check of a readiness read fails (the GitHub Issues source and its label are known only from those; a
 * check the server cannot make here, `unknown`, such as the host's branch rules, does not hold them).
 */
export function prerequisitesMet(facts: GuideFacts): boolean {
  const connected = facts.apps > 0 && facts.connections.some(throughApp)
  const attested = facts.connections.some((connection) => throughApp(connection) && isCiAttested(connection))
  return connected && attested && prerequisiteChecks(facts).every((check) => check.status !== 'fail')
}

/** An automation is set up once it is enabled (Enable needs its set-up and the readiness a run needs). */
const automationDone = (agent: Agent | null): boolean => agent?.enabled === true

function detected(step: SetupStepId, facts: GuideFacts): boolean {
  if (step === 'prerequisites') return prerequisitesMet(facts)
  return isAutomationStep(step) && automationDone(findAutomations(facts.agents)[step])
}

/**
 * A step's status: done when the deployment has it set up (whatever was chosen: a step skipped and then done is done),
 * else as chosen (skipped; the last step done once the guide is finished), else to do, or arriving later for the steps
 * whose flows land in 7.52.
 */
export function stepStatus(step: SetupStepId, facts: GuideFacts, progress: Pick<SetupProgress, 'steps'>): StepStatus {
  if (detected(step, facts)) return 'done'
  const chosen = progress.steps[step]
  if (chosen === 'skipped') return 'skipped'
  if (step === 'ready' && chosen === 'done') return 'done'
  return LATER_STEPS.has(step) ? 'later' : 'todo'
}

export type StepStatuses = Readonly<Record<SetupStepId, StepStatus>>

export function stepStatuses(facts: GuideFacts, progress: Pick<SetupProgress, 'steps'>): StepStatuses {
  return {
    prerequisites: stepStatus('prerequisites', facts, progress),
    understand: stepStatus('understand', facts, progress),
    tenets: stepStatus('tenets', facts, progress),
    triage: stepStatus('triage', facts, progress),
    bug_fixer: stepStatus('bug_fixer', facts, progress),
    feature_builder: stepStatus('feature_builder', facts, progress),
    ready: stepStatus('ready', facts, progress),
  }
}

/** The step the guide recommends next: the first, in order, neither done nor skipped (the last one once all are). */
export function recommendedGuideStep(statuses: StepStatuses): SetupStepId {
  return GUIDE_STEPS.find((step) => statuses[step] === 'todo' || statuses[step] === 'later') ?? 'ready'
}

/** The first step after `step`, in order, still open (to do, or arriving later); the last one when none is. */
export function nextOpenStep(step: SetupStepId, statuses: StepStatuses): SetupStepId {
  return GUIDE_STEPS.slice(GUIDE_STEPS.indexOf(step) + 1)
    .find((next) => statuses[next] === 'todo' || statuses[next] === 'later') ?? 'ready'
}

/** The steps before `step`, in order, that are not done: what the recommended order would have had first. */
export function notDoneBefore(step: SetupStepId, statuses: StepStatuses): SetupStepId[] {
  return GUIDE_STEPS.slice(0, GUIDE_STEPS.indexOf(step)).filter((before) => statuses[before] !== 'done')
}

/** Whether a step can be skipped for now: any step not done (the last one is finished, never skipped). */
export const canSkip = (step: SetupStepId, status: StepStatus): boolean =>
  step !== 'ready' && (status === 'todo' || status === 'later')

/** Nothing is set up yet: no GitHub connection and no engineering automation enabled. */
export function nothingSetUp(facts: Pick<GuideFacts, 'agents' | 'connections'>): boolean {
  const enabled = facts.agents.some((agent) => agent.engineering !== null && agent.status === 'active' && agent.enabled)
  return !enabled && !facts.connections.some((connection) => connection.host === 'github')
}

/** The Agents list offers "Help me set up" or "Skip" on a first visit: no choice made yet, and nothing set up. */
export function offersIntro(progress: Pick<SetupProgress, 'intro'>, facts: Pick<GuideFacts, 'agents' | 'connections'>): boolean {
  return progress.intro === 'unseen' && nothingSetUp(facts)
}

/** The automation "Run on an issue now" starts: the Issue triage automation when enabled, else the Bug fixer. */
export function issueRunner(automations: Automations): Agent | null {
  return [automations.triage, automations.bug_fixer].find((agent) => agent?.enabled === true) ?? null
}

/** How many steps are done, out of the steps that can be done in this release (the later ones left out). */
export function progressCount(statuses: StepStatuses): { done: number; total: number } {
  const counted = GUIDE_STEPS.filter((step) => !LATER_STEPS.has(step) && step !== 'ready')
  return { done: counted.filter((step) => statuses[step] === 'done').length, total: counted.length }
}
