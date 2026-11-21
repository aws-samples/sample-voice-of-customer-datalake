/**
 * The role playbook's checklist (7.66.00): pinned to schemas/playbooks.json, ticked by the server's signals, by what
 * Home reads in the browser or by hand, a loading evidence pending, and a tick that never hides real evidence.
 */
import { describe, expect, it } from 'vitest'
import catalogue from '../../../../../schemas/playbooks.json'
import { DEFAULT_ONBOARDING } from '../../../api/onboardingApi'
import type { Project } from '../../../api/projectTypes'
import { needsEvidence, PLAYBOOKS, ROLES } from './playbookCatalogue'
import { browserEvidence, derivePlaybook, toggledTicks } from './playbookSteps'
import type { BrowserFacts } from './playbookSteps'

const SUB = 'sub-me'
const project = (overrides: Partial<Project> = {}): Project => ({
  project_id: 'p1', name: 'P', description: '', status: 'active', created_at: '', updated_at: '', persona_count: 0,
  document_count: 0, owner: { sub: SUB, username: 'me', email: 'me@example.com' }, ...overrides,
})
const NOTHING: BrowserFacts = { userSub: SUB, sessionCount: 0, projects: [], connectionCount: 0, tokenCount: 0 }
const LOADING: BrowserFacts = { userSub: SUB, sessionCount: undefined, projects: undefined, connectionCount: undefined,
  tokenCount: undefined }
const statuses = (steps: ReturnType<typeof derivePlaybook>) => Object.fromEntries(steps.map((step) => [step.id, step.status]))

describe('the catalogue', () => {
  it('is the schema the server is pinned to, every role and step', () => {
    expect(ROLES).toStrictEqual(catalogue.roles)
    for (const role of ROLES) {
      expect(PLAYBOOKS[role]).toStrictEqual(catalogue.steps[role])
      expect(PLAYBOOKS[role].length).toBeGreaterThanOrEqual(5)
      expect(PLAYBOOKS[role].length).toBeLessThanOrEqual(8)
    }
  })

  it('reads only the evidence the chosen playbook needs', () => {
    expect([needsEvidence('engineering', 'repository_connected'), needsEvidence('qa', 'repository_connected'),
      needsEvidence(null, 'assistant_used')]).toStrictEqual([true, false, false])
  })
})

describe('derivePlaybook', () => {
  it('has no steps without a role', () => {
    expect(derivePlaybook(null, DEFAULT_ONBOARDING, NOTHING)).toStrictEqual([])
  })

  it('ticks the QA steps from the server signals, the rest to do', () => {
    const preference = { ...DEFAULT_ONBOARDING, signals: { feedback_present: true, feedback_form_configured: true,
      form_test_response: false } }
    expect(statuses(derivePlaybook('qa', preference, NOTHING))).toStrictEqual({
      create_form: 'done', test_form: 'todo', search_feedback: 'todo', review_problems: 'todo', watch_release: 'todo',
      ask_assistant: 'todo',
    })
  })

  it('reads a signal the server did not send yet as pending, and a manual step as to do', () => {
    const steps = statuses(derivePlaybook('product', DEFAULT_ONBOARDING, LOADING))
    expect([steps['set_objectives'], steps['ask_assistant'], steps['read_dashboard']]).toStrictEqual(['pending', 'pending', 'todo'])
  })

  it('ticks a step by hand, and lets the person untick it', () => {
    const steps = derivePlaybook('product', { ...DEFAULT_ONBOARDING, playbook_done: ['read_dashboard'] }, NOTHING)
    expect(steps.find((step) => step.id === 'read_dashboard')).toMatchObject({ status: 'done', ticked: true })
    expect(toggledTicks(['read_dashboard', 'x'], 'read_dashboard', false)).toStrictEqual(['x'])
    expect(toggledTicks(['x'], 'read_dashboard', true)).toStrictEqual(['x', 'read_dashboard'])
  })

  it('never calls a step the evidence ticked a hand tick', () => {
    const preference = { ...DEFAULT_ONBOARDING, playbook_done: ['ask_assistant'] }
    const step = derivePlaybook('qa', preference, { ...NOTHING, sessionCount: 2 }).find((s) => s.id === 'ask_assistant')
    expect(step).toMatchObject({ status: 'done', ticked: false })
  })
})

describe('browserEvidence', () => {
  it("counts only the person's own projects", () => {
    const theirs = project({ owner: { sub: 'someone-else', username: 'x', email: 'x@example.com' }, persona_count: 3, document_count: 2, member_count: 4 })
    const facts = { ...NOTHING, projects: [theirs] }
    const names = ['project_owned', 'personas_generated', 'document_written', 'project_shared'] as const
    expect(names.map((name) => browserEvidence(name, facts))).toStrictEqual([false, false, false, false])
  })

  it('reads personas, documents and sharing from their own projects', () => {
    const facts = { ...NOTHING, projects: [project({ persona_count: 2 }), project({ document_count: 1, visibility: 'public' })] }
    expect([browserEvidence('personas_generated', facts), browserEvidence('document_written', facts),
      browserEvidence('project_shared', facts)]).toStrictEqual([true, true, true])
    expect(browserEvidence('project_shared', { ...NOTHING, projects: [project({ member_count: 1 })] })).toBe(true)
  })

  it('reads the connections, tokens and sessions counts, unknown while loading', () => {
    expect([browserEvidence('repository_connected', { ...NOTHING, connectionCount: 1 }),
      browserEvidence('mcp_connected', { ...NOTHING, tokenCount: 0 }),
      browserEvidence('assistant_used', LOADING)]).toStrictEqual([true, false, undefined])
  })
})
