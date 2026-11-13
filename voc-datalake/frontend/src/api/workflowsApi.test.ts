/**
 * @fileoverview An engineering flow's monthly budget in the editor's schema (the server's rule: an engineering flow
 * only, dollars and cents from 0.01 up to the largest) and in the lenient read, which keeps it so a save never drops it.
 */
import { describe, expect, it } from 'vitest'
import { ENGINEERING_MAX_MONTHLY_BUDGET_USD } from '@stream/assistant/tools/agent-limits'
import { normalizeDefinition, workflowDefinitionSchema } from './workflowsApi'
import { engineeringFlowView } from '@test/engineeringRunFixtures'
import { emptyDefinition } from '../components/WorkflowEditor/model-fixtures'

const flow = engineeringFlowView().workflow.definition
const withBudget = (monthly: unknown) => ({ ...flow, budget: { monthly_usd: monthly } })

describe('an engineering flow\'s monthly budget', () => {
  it.each([50, 49.99, 0.01, 12.5, ENGINEERING_MAX_MONTHLY_BUDGET_USD])('takes %d dollars', (monthly) => {
    expect(workflowDefinitionSchema.safeParse(withBudget(monthly)).success).toBe(true)
  })

  it.each([0, 0.004, 0.005, 49.999, -1, ENGINEERING_MAX_MONTHLY_BUDGET_USD + 1, ENGINEERING_MAX_MONTHLY_BUDGET_USD + 0.01, Number.NaN, '50'])('refuses %s', (monthly) => {
    expect(workflowDefinitionSchema.safeParse(withBudget(monthly)).success).toBe(false)
  })

  it('refuses anything else in the budget, and a budget on an agents workflow', () => {
    expect(workflowDefinitionSchema.safeParse({ ...flow, budget: { monthly_usd: 50, hard: true } }).success).toBe(false)
    expect(workflowDefinitionSchema.safeParse({ ...emptyDefinition('Flow'), budget: { monthly_usd: 50 } }).success).toBe(false)
  })

  it('is kept by the lenient read, and an unreadable one reads as none', () => {
    expect(normalizeDefinition(withBudget(80))?.budget).toStrictEqual({ monthly_usd: 80 })
    expect(normalizeDefinition({ ...flow, budget: 'lots' })).not.toHaveProperty('budget')
    expect(normalizeDefinition(flow)).not.toHaveProperty('budget')
    expect(normalizeDefinition({ ...emptyDefinition('Flow'), budget: { monthly_usd: 5 } })).not.toHaveProperty('budget')
  })
})
