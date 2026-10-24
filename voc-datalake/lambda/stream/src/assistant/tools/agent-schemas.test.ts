import { describe, it, expect } from 'vitest';
import { workflowDefinitionSchema } from './agent-schemas.js';

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
