import { describe, it, expect } from 'vitest';
import { AGENT_BUDGET_RULES, AGENT_LIMITS, MONTHLY_BUDGET_RULE } from './agent-limits.js';
import { agentFieldsShape, workflowDefinitionSchema } from './agent-schemas.js';

function definitionAt(x: number, y: number): unknown {
  return {
    schema: 'voc-workflow/1',
    name: 'Flow',
    nodes: [{ id: 'n1', type: 'start', position: { x, y }, data: { title: 'Start' } }],
    edges: [],
    loops: [],
  };
}

describe('workflowDefinitionSchema node positions', () => {
  it('accepts finite coordinates', () => {
    expect(workflowDefinitionSchema.safeParse(definitionAt(10, -5.5)).success).toBe(true);
  });

  // zod 4's z.number() rejects non-finite numbers itself (v3 needed `.finite()`).
  it.each([
    [Number.POSITIVE_INFINITY, 0],
    [0, Number.NEGATIVE_INFINITY],
    [Number.NaN, 0],
  ])('rejects the non-finite position (%s, %s)', (x, y) => {
    expect(workflowDefinitionSchema.safeParse(definitionAt(x, y)).success).toBe(false);
  });
});

describe('workflowDefinitionSchema monthly budget', () => {
  const withBudget = (schema: string, budget: unknown) => ({ ...(definitionAt(0, 0) as object), schema, budget });

  // (the server's cases: test_workflow_engineering.py)
  it.each([50, 49.99, 0.01, 12.5, 100_000])('takes %s dollars', (monthly) => {
    expect(workflowDefinitionSchema.safeParse(withBudget('voc-workflow/2', { monthly_usd: monthly })).success).toBe(true);
  });

  it('says its rule in the server\'s words', () => {
    expect(MONTHLY_BUDGET_RULE).toBe('budget is {monthly_usd}: what its runs may spend in a month, in dollars and cents from 0.01 to 100,000');
  });

  it.each([0, 0.004, 0.005, 49.999, -5, 100_001, 100_000.01, '50', null])('refuses %s dollars', (monthly) => {
    expect(workflowDefinitionSchema.safeParse(withBudget('voc-workflow/2', { monthly_usd: monthly })).success).toBe(false);
  });

  it('refuses a budget on an agents workflow, and anything else in one', () => {
    expect(workflowDefinitionSchema.safeParse(withBudget('voc-workflow/1', { monthly_usd: 50 })).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(withBudget('voc-workflow/2', { monthly_usd: 50, cap: true })).success).toBe(false);
  });
});

// The SPA's approval boundary builds its budget schema from AGENT_BUDGET_RULES and a non-nullable
// monthly cap (frontend/src/assistant/approvals/agentSchemas.ts): these pin that the stream's own
// schema applies exactly those rules.
describe('agent budget rules', () => {
  const budget = agentFieldsShape.budget;

  it('takes at least minModelCallsPerRun model calls per run', () => {
    const min = AGENT_BUDGET_RULES.minModelCallsPerRun;
    expect(budget.safeParse({ max_model_calls_per_run: min }).success).toBe(true);
    expect(budget.safeParse({ max_model_calls_per_run: min - 1 }).success).toBe(false);
    expect(budget.safeParse({ max_model_calls_per_run: AGENT_LIMITS.maxModelCallsPerRun + 1 }).success).toBe(false);
  });

  it('refuses a null monthly cap (the agents Lambda takes null = no cap; the assistant does not offer it)', () => {
    expect(budget.safeParse({ monthly_call_cap: null }).success).toBe(false);
    expect(budget.safeParse({ monthly_call_cap: AGENT_LIMITS.maxMonthlyCallCap }).success).toBe(true);
  });
});
