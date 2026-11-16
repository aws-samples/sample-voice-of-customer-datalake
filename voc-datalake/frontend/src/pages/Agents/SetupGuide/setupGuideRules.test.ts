/**
 * @fileoverview The setup guide's rules (setupGuideRules.ts): the seeded automations found among the agents, the
 * prerequisites read from the connections, the Apps and the automations' readiness, each step's status (done when the
 * deployment has it, whatever was chosen; else skipped as chosen; else to do or arriving in 7.52), the recommended
 * order (never a lock), the first visit's offer and the automation "Run on an issue now" starts.
 */
import { describe, expect, it } from 'vitest'
import { normalizeAgent } from '../../../api/agentsApi'
import { parseConnection } from '../../../api/engineeringConnectionsApi'
import { SETUP_STEP_IDS } from '../../../api/engineeringSetupApi'
import {
  canSkip, findAutomations, issueRunner, nextOpenStep, notDoneBefore, nothingSetUp, offersIntro, prerequisiteChecks,
  prerequisitesMet, progressCount, recommendedGuideStep, stepStatus, stepStatuses,
} from './setupGuideRules'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { SetupProgress, SetupStepId, StepChoice } from '../../../api/engineeringSetupApi'
import type { GuideFacts, StepStatus, StepStatuses } from './setupGuideRules'

function agent(id: string, name: string, extra: Record<string, unknown> = {}): Agent {
  const made = normalizeAgent({
    agent_id: `ag_${id.padStart(12, '0')}`, name, enabled: false, status: 'active',
    engineering: { connection: null, language: null, feedback_type: 'bug' }, ...extra,
  })
  if (made === null) throw new Error('fixture agent did not normalise')
  return made
}

function connection(extra: Record<string, unknown> = {}): EngineeringConnection {
  const made = parseConnection({
    connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
    credential: { kind: 'app_reference', set: true, app_id: '123', installation_id: '456', expires_at: null }, version: 2,
    ci_attestation: { version: 1, state: 'attested', repository: 'example-org/storefront', points: [], by: 'alice',
      at: '2026-11-01T00:00:00+00:00', connection_version: 2 },
    ...extra,
  })
  if (made === null) throw new Error('fixture connection did not parse')
  return made
}

const check = (id: string, status: ReadinessCheck['status']): ReadinessCheck =>
  ({ id, status, detail: '', fix: '', docs: '', required: id === 'connection' || id === 'ci_attestation' || id === 'dial' })
const FEATURES = { connection: null, language: null, feedback_type: 'feature_request' }
const on = (made: Agent): Agent => ({ ...made, enabled: true })

/** The progress with every step pending but those `chosen`. */
function choices(chosen: Partial<Record<SetupStepId, StepChoice>> = {}): Pick<SetupProgress, 'steps'> {
  const steps: Record<SetupStepId, StepChoice> = {
    prerequisites: 'pending', understand: 'pending', tenets: 'pending', triage: 'pending', bug_fixer: 'pending',
    feature_builder: 'pending', ready: 'pending',
  }
  return { steps: { ...steps, ...chosen } }
}

/** Every step at `status`. */
function every(status: StepStatus): StepStatuses {
  return { prerequisites: status, understand: status, tenets: status, triage: status, bug_fixer: status,
    feature_builder: status, ready: status }
}

const triage = agent('1', 'Issue triage')
const bugFixer = agent('2', 'Bug fixer')
const featureBuilder = agent('3', 'Feature builder', { engineering: FEATURES })

function facts(extra: Partial<GuideFacts> = {}): GuideFacts {
  return { agents: [triage, bugFixer, featureBuilder], connections: [connection()], apps: 1, readiness: {}, ...extra }
}

describe('the seeded automations', () => {
  it('are found by their seeded names, whatever the case', () => {
    const shouting = agent('4', ' ISSUE TRIAGE ')
    expect(findAutomations([shouting, bugFixer, featureBuilder])).toStrictEqual({
      triage: shouting, bug_fixer: bugFixer, feature_builder: featureBuilder,
    })
  })

  it('finds a renamed Bug fixer or Feature builder by what it works on, never the triage one as the bug fixer', () => {
    const renamedBugs = agent('5', 'Fixes things')
    const renamedFeatures = agent('6', 'Builds things', { engineering: FEATURES })
    expect(findAutomations([triage, renamedBugs, renamedFeatures])).toStrictEqual({
      triage, bug_fixer: renamedBugs, feature_builder: renamedFeatures,
    })
    expect(findAutomations([triage]).bug_fixer).toBeNull()
  })

  it('leaves out archived agents and agents that run an agents workflow', () => {
    const archived = agent('7', 'Bug fixer', { status: 'archived' })
    const plain = agent('8', 'Issue triage', { engineering: null })
    expect(findAutomations([archived, plain])).toStrictEqual({ triage: null, bug_fixer: null, feature_builder: null })
  })
})

describe('the prerequisites', () => {
  it('are met with GitHub connected through an App, its CI attested and no prerequisite check failing', () => {
    expect([
      prerequisitesMet(facts()),
      prerequisitesMet(facts({ apps: 0 })),
      prerequisitesMet(facts({ connections: [connection({ ci_attestation: null })] })),
      prerequisitesMet(facts({ connections: [connection({ credential: { kind: 'project_token', set: true } })] })),
    ]).toStrictEqual([true, false, false, false])
  })

  it('wait for a failing prerequisite check, never a warning, an unknown one or another step\'s check', () => {
    expect(prerequisitesMet(facts({ readiness: { bug_fixer: [check('issue_label', 'fail')] } }))).toBe(false)
    expect(prerequisitesMet(facts({ readiness: { bug_fixer: [check('issues_source', 'warn'), check('ci_protection', 'unknown'),
      check('dial', 'fail')] } }))).toBe(true)
  })

  it('keep one check per id, the worst any automation got', () => {
    const readiness = {
      triage: [check('issues_source', 'pass'), check('dial', 'fail'), check('ci_protection', 'warn')],
      bug_fixer: [check('issues_source', 'fail'), check('issue_label', 'warn'), check('ci_protection', 'unknown')],
      feature_builder: [check('issue_label', 'pass')],
    }
    expect(prerequisiteChecks({ readiness }).map((entry) => [entry.id, entry.status]))
      .toStrictEqual([['issues_source', 'fail'], ['ci_protection', 'unknown'], ['issue_label', 'warn']])
  })
})

describe('a step\'s status', () => {
  it('is done once the deployment has it, whatever was chosen', () => {
    const enabled = facts({ agents: [on(triage), bugFixer, featureBuilder] })
    expect(stepStatus('triage', enabled, choices({ triage: 'skipped' }))).toBe('done')
    expect(stepStatus('prerequisites', facts(), choices())).toBe('done')
  })

  it('is skipped as chosen, else to do, or arriving in 7.52 for Understand and Tenets', () => {
    const none = facts({ apps: 0 })
    expect([
      stepStatus('prerequisites', none, choices({ prerequisites: 'skipped' })),
      stepStatus('bug_fixer', none, choices()),
      stepStatus('understand', none, choices()),
      stepStatus('tenets', none, choices({ tenets: 'skipped' })),
    ]).toStrictEqual(['skipped', 'todo', 'later', 'skipped'])
  })

  it('takes "done" as chosen only for the last step: a step the deployment can tell is never marked done by hand', () => {
    expect([
      stepStatus('ready', facts(), choices({ ready: 'done' })),
      stepStatus('bug_fixer', facts(), choices({ bug_fixer: 'done' })),
      stepStatus('understand', facts(), choices({ understand: 'done' })),
    ]).toStrictEqual(['done', 'todo', 'later'])
  })
})

describe('the recommended order', () => {
  const statuses = (overrides: Partial<StepStatuses>): StepStatuses => ({ ...stepStatuses(facts({ apps: 0 }), choices()), ...overrides })

  it('recommends the first step neither done nor skipped, the last when none is left', () => {
    expect([
      recommendedGuideStep(statuses({})),
      recommendedGuideStep(statuses({ prerequisites: 'done', understand: 'skipped' })),
      recommendedGuideStep(every('done')),
    ]).toStrictEqual(['prerequisites', 'tenets', 'ready'])
  })

  it('moves on from a skip to the next step still open', () => {
    expect(nextOpenStep('prerequisites', statuses({ understand: 'skipped' }))).toBe('tenets')
    expect(nextOpenStep('feature_builder', statuses({}))).toBe('ready')
  })

  it('names the steps before one that are not done', () => {
    expect(notDoneBefore('triage', statuses({ prerequisites: 'done', understand: 'skipped' }))).toStrictEqual(['understand', 'tenets'])
    expect(notDoneBefore('prerequisites', statuses({}))).toStrictEqual([])
  })

  it('locks none: every open step can be skipped', () => {
    expect(SETUP_STEP_IDS.filter((step) => canSkip(step, 'todo'))).toStrictEqual(SETUP_STEP_IDS.filter((step) => step !== 'ready'))
    expect([canSkip('triage', 'later'), canSkip('triage', 'done'), canSkip('triage', 'skipped')]).toStrictEqual([true, false, false])
  })

  it('counts the steps that can be done in this release', () => {
    expect(progressCount(statuses({ prerequisites: 'done', understand: 'done', triage: 'done' }))).toStrictEqual({ done: 2, total: 4 })
  })
})

describe('the first visit', () => {
  const empty = { agents: [triage, bugFixer], connections: [] }

  it('offers the guide while no choice is made and nothing is set up', () => {
    expect([offersIntro({ intro: 'unseen' }, empty), offersIntro({ intro: 'skipped' }, empty), offersIntro({ intro: 'started' }, empty)])
      .toStrictEqual([true, false, false])
  })

  it('offers nothing once a GitHub connection is stored or an automation is enabled', () => {
    expect([
      offersIntro({ intro: 'unseen' }, { agents: [], connections: [connection()] }),
      offersIntro({ intro: 'unseen' }, { agents: [on(bugFixer)], connections: [] }),
      // (a GitLab connection sets nothing up for the GitHub issue loop)
      nothingSetUp({ agents: [], connections: [connection({ host: 'gitlab' })] }),
    ]).toStrictEqual([false, false, true])
  })
})

describe('Run on an issue now', () => {
  it('starts from Issue triage when enabled, else the Bug fixer, else nothing', () => {
    expect([
      issueRunner(findAutomations([on(triage), on(bugFixer)]))?.name,
      issueRunner(findAutomations([triage, on(bugFixer)]))?.name,
      issueRunner(findAutomations([triage, bugFixer, on(featureBuilder)])),
    ]).toStrictEqual(['Issue triage', 'Bug fixer', null])
  })
})
