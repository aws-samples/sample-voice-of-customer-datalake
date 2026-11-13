/**
 * The agent approval boundary is built from the stream's own limits
 * (`@stream/assistant/tools/agent-limits`): these pin the budget rules the SPA adds
 * on top (the stream's agent-schemas.test.ts pins the same rules on its side) and
 * that a bound comes from the stream, not from the agents Lambda's API limits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUDGET_RULES, AGENT_LIMITS, WORKFLOW_LIMITS } from '@stream/assistant/tools/agent-limits'
import { engineeringModule as engineering } from '@test/engineeringModule'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { createAgentArgs, createWorkflowArgs, duplicateWorkflowArgs, updateWorkflowArgs } from './agentSchemas'

vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const SCOPE = { all: true, categories: [], subcategories: [] }
const agent = (fields: Record<string, unknown>) => createAgentArgs.safeParse({ name: 'Agent', scope: SCOPE, ...fields })

describe('agent approval schema', () => {
  it('takes at least the stream\u2019s minimum model calls per run', () => {
    const min = AGENT_BUDGET_RULES.minModelCallsPerRun
    expect(agent({ budget: { max_model_calls_per_run: min } }).success).toBe(true)
    expect(agent({ budget: { max_model_calls_per_run: min - 1 } }).success).toBe(false)
    expect(min).not.toBe(API_AGENT_LIMITS.minModelCallsPerRun)
  })

  it('refuses a null monthly cap, like the stream (the agents API itself takes null)', () => {
    expect(API_AGENT_LIMITS.monthlyCapNullable).toBe(true)
    expect(agent({ budget: { monthly_call_cap: null } }).success).toBe(false)
    expect(agent({ budget: { monthly_call_cap: AGENT_LIMITS.maxMonthlyCallCap } }).success).toBe(true)
  })

  it('bounds the name by the stream\u2019s limit', () => {
    expect(agent({ name: 'a'.repeat(AGENT_LIMITS.maxNameChars) }).success).toBe(true)
    expect(agent({ name: 'a'.repeat(AGENT_LIMITS.maxNameChars + 1) }).success).toBe(false)
  })
})

describe('an engineering flow drafted by the assistant', () => {
  const flow = (schema: string) => ({ definition: {
    schema, name: 'Bug hunt', loops: [],
    nodes: [{ id: 'n_start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
      { id: 'n_hunt', type: 'agent', position: { x: 0, y: 1 }, data: { title: 'Hunt', params: { role: 'hunter' } } },
      { id: 'n_end', type: 'end', position: { x: 0, y: 2 }, data: { title: 'End' } }],
    edges: [{ id: 'e1', source: 'n_start', target: 'n_hunt' }, { id: 'e2', source: 'n_hunt', target: 'n_end' }],
  } })

  afterEach(() => { engineering.available = false })

  const cards = () => [
    createWorkflowArgs.safeParse(flow('voc-workflow/2')).success,
    updateWorkflowArgs.safeParse({ workflow_id: 'wf_1', expected_revision: 1, change_summary: 'More',
      ...flow('voc-workflow/2') }).success,
  ]

  it('is created only where the deployment has the engineering module, and one saved is changed anywhere', () => {
    expect(cards()).toStrictEqual([false, true])   // (as the editor: only New engineering flow is gated)
    engineering.available = true
    expect(cards()).toStrictEqual([true, true])
  })

  it.each([false, true])('leaves an agents workflow as it was (module %s), and refuses any other schema', (available) => {
    engineering.available = available
    const agents = { ...flow('voc-workflow/1').definition, nodes: [
      { id: 'n_start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
      { id: 'n_end', type: 'end', position: { x: 0, y: 2 }, data: { title: 'End' } }],
    edges: [{ id: 'e1', source: 'n_start', target: 'n_end' }] }
    expect([createWorkflowArgs.safeParse({ definition: agents }).success,
      createWorkflowArgs.safeParse(flow('voc-workflow/3')).success]).toStrictEqual([true, false])
  })
})

describe('workflow approval schema', () => {
  it('bounds a duplicated workflow\u2019s name by the stream\u2019s limit', () => {
    const duplicate = (n: number) => duplicateWorkflowArgs.safeParse({ workflow_id: 'wf_1', name: 'a'.repeat(n) }).success
    expect(duplicate(WORKFLOW_LIMITS.maxNameChars)).toBe(true)
    expect(duplicate(WORKFLOW_LIMITS.maxNameChars + 1)).toBe(false)
  })
})
