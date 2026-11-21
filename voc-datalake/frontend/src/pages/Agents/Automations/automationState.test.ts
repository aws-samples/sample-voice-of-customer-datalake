/**
 * @fileoverview An automation's one state and primary (7.52.00 C1, ux-agents-redesign part 1 §2.3): each row of the
 * state table, the needs-a-decision override, a person who is not an administrator, the reads loading and failing,
 * and the exact Paused state the server answers (7.52.00 B).
 */
import { describe, expect, it } from 'vitest'
import { normalizeAgent } from '../../../api/agentsApi'
import { parseConnection } from '../../../api/engineeringConnectionsApi'
import { automationState, groupAutomations } from './automationState'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { AutomationInput } from './automationState'

function agentOf(extra: Record<string, unknown> = {}): Agent {
  const agent = normalizeAgent({ agent_id: 'ag_1', name: 'Bug fixer', enabled: false, workflow_id: 'wf_1', ...extra })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const ENGINEERING = { engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' } }
const NOT_SET_UP = { engineering: { connection: null, language: null, feedback_type: 'bug' } }
/** A connection as the server answers it (the parser's defaults for every field the rules do not read). */
const PARSED = parseConnection({
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main', version: 1,
  credential: { kind: 'app', set: true },
})
if (PARSED === null) throw new Error('fixture connection does not parse')
const CONNECTION: EngineeringConnection = PARSED
const FACTS = { state: 'ready', connections: [CONNECTION], budget: 50 } as const
const NO_CONNECTION = { state: 'ready', connections: [], budget: 50 } as const
const LOADING = { state: 'loading', connections: [], budget: null } as const
const FAILED = { state: 'failed', connections: [], budget: null } as const
const check = (id: string, status: ReadinessCheck['status'], required = true): ReadinessCheck =>
  ({ id, status, detail: '', fix: '', docs: '', required })

const stateOf = (input: Partial<AutomationInput> & { agent: Agent }) =>
  automationState({ isAdmin: true, engineering: FACTS, checks: undefined, ...input })

describe('an engineering automation', () => {
  it('needs setup with no primary while it has no connection it can use (the group says so once)', () => {
    const state = stateOf({ agent: agentOf(ENGINEERING), engineering: NO_CONNECTION })
    expect([state.state, state.primary]).toStrictEqual(['needs_setup', null])
  })

  it('needs setup with Set up while it is not set up (no language), counting its checks to fix once read', () => {
    const state = stateOf({ agent: agentOf(NOT_SET_UP), checks: [check('ci_attestation', 'fail'), check('dial', 'unknown'), check('network', 'pass')] })
    expect([state.state, state.primary, state.toFix]).toStrictEqual(['needs_setup', 'set_up', 2])
  })

  it('needs setup with Set up while set up but a check a run needs does not pass', () => {
    const state = stateOf({ agent: agentOf(ENGINEERING), checks: [check('ci_attestation', 'fail')] })
    expect([state.state, state.primary, state.toFix]).toStrictEqual(['needs_setup', 'set_up', 1])
  })

  it("can't run, with Fix, when it is on and its connection was removed", () => {
    const state = stateOf({ agent: agentOf({ ...ENGINEERING, enabled: true }), engineering: NO_CONNECTION })
    expect([state.state, state.primary, state.reason]).toStrictEqual(['cant_run', 'fix', 'connection_gone'])
  })

  it('is ready with Enable when set up and nothing holds it, saying its warnings', () => {
    const state = stateOf({ agent: agentOf(ENGINEERING), checks: [check('agentcore_quota', 'warn', false), check('network', 'pass')] })
    expect([state.state, state.primary, state.toFix, state.warnings]).toStrictEqual(['ready', 'enable', 0, 1])
  })

  it('never counts an advisory failure as one to fix', () => {
    expect(stateOf({ agent: agentOf(ENGINEERING), checks: [check('ci_protection', 'fail', false)] }).primary).toBe('enable')
  })

  it('loads while its engineering reads are on their way', () => {
    expect(stateOf({ agent: agentOf(ENGINEERING), engineering: LOADING })).toMatchObject({ state: 'loading', primary: null })
  })

  it('comes from the enabled flag alone when a read failed, Set up still offered', () => {
    expect(stateOf({ agent: agentOf(ENGINEERING), engineering: FAILED }))
      .toMatchObject({ state: 'ready', primary: 'set_up', unchecked: true })
    expect(stateOf({ agent: agentOf({ ...ENGINEERING, enabled: true }), engineering: FAILED }))
      .toMatchObject({ state: 'enabled', primary: 'run_now', unchecked: true })
  })
})

describe('every automation', () => {
  it('is paused, with Resume, when the server says so (exact: on and paused)', () => {
    const state = stateOf({ agent: agentOf({ ...ENGINEERING, enabled: true, paused: true, paused_at: '2026-11-16T10:00:00Z', paused_by: 'admin' }) })
    expect([state.state, state.primary]).toStrictEqual(['paused', 'resume'])
  })

  it('is enabled with Run now, a cap skip as its reason', () => {
    const state = stateOf({ agent: agentOf({ enabled: true, stats: { last_skip_reason: 'monthly_cap' } }) })
    expect([state.state, state.primary, state.reason]).toStrictEqual(['enabled', 'run_now', 'monthly_cap'])
  })

  it('is ready with Enable when off (a product automation needs no engineering read)', () => {
    expect(stateOf({ agent: agentOf(), engineering: LOADING })).toMatchObject({ state: 'ready', primary: 'enable' })
  })

  it('offers Review when its last run waits for a person, the chip unchanged', () => {
    const state = stateOf({ agent: agentOf({ enabled: true, stats: { last_run_status: 'needs_human' } }) })
    expect([state.state, state.primary, state.needsDecision]).toStrictEqual(['enabled', 'review', true])
  })

  it('offers a person who is not an administrator the state and no action, without engineering reads', () => {
    expect(stateOf({ agent: agentOf({ ...ENGINEERING, enabled: true }), isAdmin: false, engineering: LOADING }))
      .toMatchObject({ state: 'enabled', primary: null, unchecked: false })
  })
})

describe('the groups', () => {
  it('puts the engineering automations apart from the product ones, each in the server order', () => {
    const groups = groupAutomations([agentOf({ agent_id: 'ag_p', name: 'Autonomous Product' }),
      agentOf({ agent_id: 'ag_t', name: 'Issue triage', ...ENGINEERING }), agentOf({ agent_id: 'ag_b', ...ENGINEERING })])
    expect([groups.engineering.map((a) => a.agent_id), groups.product.map((a) => a.agent_id)])
      .toStrictEqual([['ag_t', 'ag_b'], ['ag_p']])
  })
})
