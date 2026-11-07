/**
 * The agent approval boundary is built from the stream's own limits
 * (`@stream/assistant/tools/agent-limits`): these pin the budget rules the SPA adds
 * on top (the stream's agent-schemas.test.ts pins the same rules on its side) and
 * that a bound comes from the stream, not from the agents Lambda's API limits.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_BUDGET_RULES, AGENT_LIMITS, WORKFLOW_LIMITS } from '@stream/assistant/tools/agent-limits'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { createAgentArgs, duplicateWorkflowArgs } from './agentSchemas'

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

describe('workflow approval schema', () => {
  it('bounds a duplicated workflow\u2019s name by the stream\u2019s limit', () => {
    const duplicate = (n: number) => duplicateWorkflowArgs.safeParse({ workflow_id: 'wf_1', name: 'a'.repeat(n) }).success
    expect(duplicate(WORKFLOW_LIMITS.maxNameChars)).toBe(true)
    expect(duplicate(WORKFLOW_LIMITS.maxNameChars + 1)).toBe(false)
  })
})
