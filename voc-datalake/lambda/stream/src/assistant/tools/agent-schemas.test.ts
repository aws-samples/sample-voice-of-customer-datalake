import { describe, it, expect } from 'vitest';
import { AGENT_BUDGET_RULES, AGENT_LIMITS } from './agent-limits.js';
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

// The SPA's approval boundary builds its budget schema from AGENT_BUDGET_RULES: these pin that the
// stream's own schema applies exactly those rules.
describe('agent budget rules', () => {
  const budget = agentFieldsShape.budget;

  it('takes at least minModelCallsPerRun model calls per run', () => {
    const min = AGENT_BUDGET_RULES.minModelCallsPerRun;
    expect(budget.safeParse({ max_model_calls_per_run: min }).success).toBe(true);
    expect(budget.safeParse({ max_model_calls_per_run: min - 1 }).success).toBe(false);
    expect(budget.safeParse({ max_model_calls_per_run: AGENT_LIMITS.maxModelCallsPerRun + 1 }).success).toBe(false);
  });

  it('accepts a null monthly cap exactly when monthlyCapNullable says so', () => {
    expect(budget.safeParse({ monthly_call_cap: null }).success).toBe(AGENT_BUDGET_RULES.monthlyCapNullable);
    expect(budget.safeParse({ monthly_call_cap: AGENT_LIMITS.maxMonthlyCallCap }).success).toBe(true);
  });
});
