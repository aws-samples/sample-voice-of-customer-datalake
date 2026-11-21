/**
 * @fileoverview A role playbook's checklist, derived from REAL state (7.66.00, docs/playbooks.md).
 *
 * Pure: `derivePlaybook` turns the chosen role's steps (playbookCatalogue.ts), the onboarding GET's signals, what Home
 * already reads in the browser and the steps the person ticked by hand into statuses. A step whose evidence says it
 * happened is done; one the person ticked is done too (`ticked`: they may untick it); one whose evidence is still
 * loading is `pending` (neither counted done nor shown missing); the rest are to do.
 *
 * @module pages/Home/playbooks/playbookSteps
 */
import { ownsAProject } from '../onboarding/onboardingSteps'
import { isServerEvidence, PLAYBOOKS } from './playbookCatalogue'
import type { BrowserEvidence, Evidence, PlaybookStepDef } from './playbookCatalogue'
import type { OnboardingPreference, PlaybookRole } from '../../../api/onboardingApi'
import type { Project } from '../../../api/projectTypes'
import type { StepStatus } from '../onboarding/onboardingSteps'

export interface PlaybookStep extends PlaybookStepDef {
  readonly status: StepStatus
  /** Done because the person ticked it (not because the evidence says so): they may untick it. */
  readonly ticked: boolean
}

/** What Home read in the browser for the browser evidence; `undefined` while a read is in flight (or not asked). */
export interface BrowserFacts {
  readonly userSub: string | undefined
  /** The caller's morning brief is on (its settings, as Home reads them). */
  readonly briefSubscribed: boolean | undefined
  readonly projects: readonly Project[] | undefined
  readonly connectionCount: number | undefined
  readonly tokenCount: number | undefined
}

/** The caller's own projects (one shared with them is not theirs to have shared or written in). */
function ownProjects(projects: readonly Project[], userSub: string | undefined): Project[] {
  return projects.filter((project) => ownsAProject([project], userSub))
}

const someOwn = (facts: BrowserFacts, test: (project: Project) => boolean): boolean | undefined =>
  (facts.projects === undefined ? undefined : ownProjects(facts.projects, facts.userSub).some(test))

const positive = (count: number | undefined): boolean | undefined => (count === undefined ? undefined : count > 0)

/** One browser evidence: true, false, or undefined while unknown. */
export function browserEvidence(name: BrowserEvidence, facts: BrowserFacts): boolean | undefined {
  switch (name) {
    case 'brief_subscribed': return facts.briefSubscribed
    case 'personas_generated': return someOwn(facts, (project) => project.persona_count > 0)
    case 'document_written': return someOwn(facts, (project) => project.document_count > 0)
    case 'project_shared':
      return someOwn(facts, (project) => (project.member_count ?? 0) > 0 || project.visibility === 'public')
    case 'repository_connected': return positive(facts.connectionCount)
    case 'mcp_connected': return positive(facts.tokenCount)
  }
}

function evidenceOf(evidence: Evidence, signals: OnboardingPreference['signals'], facts: BrowserFacts): boolean | undefined {
  return isServerEvidence(evidence) ? signals[evidence] : browserEvidence(evidence, facts)
}

function statusOf(step: PlaybookStepDef, ticked: boolean, seen: boolean | undefined): StepStatus {
  if (ticked || seen === true) return 'done'
  return step.evidence !== null && seen === undefined ? 'pending' : 'todo'
}

/** The chosen role's steps with their statuses (none without a role). */
export function derivePlaybook(role: PlaybookRole | null, preference: Pick<OnboardingPreference, 'signals' | 'playbook_done'>,
  facts: BrowserFacts): PlaybookStep[] {
  if (role === null) return []
  const ticks = new Set(preference.playbook_done)
  return PLAYBOOKS[role].map((step) => {
    const seen = step.evidence === null ? false : evidenceOf(step.evidence, preference.signals, facts)
    const ticked = ticks.has(step.id) && seen !== true
    return { ...step, status: statusOf(step, ticked, seen), ticked }
  })
}

/** The ticks after the person ticks (`done`) or unticks one step: the others kept, each once. */
export function toggledTicks(current: readonly string[], stepId: string, done: boolean): string[] {
  const kept = current.filter((id) => id !== stepId)
  return done ? [...kept, stepId] : kept
}
