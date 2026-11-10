/**
 * After the user approves a plan, the model reads that the plan is RUNNING and
 * that the card shows each step's result by itself — not a bare `{plan_id}` it
 * answered with "I haven't seen any results yet. Ask me to check…" (prod 5.10.00).
 */
import { describe, it, expect } from 'vitest';
import type { Message, UserMessage } from '@ag-ui/core';
import { nth } from '../../lib/nth-fixtures.js';
import { PLAN_APPROVED_NEXT, annotatePlanOutcome } from './plan-outcome.js';
import { buildTail } from './tail.js';

const user: UserMessage = { id: 'u', role: 'user', content: 'plan it' };
const approved = JSON.stringify({
  status: 'executed', summary: 'The user approved plan pl_0123456789ab.', data: { plan_id: 'pl_0123456789ab' },
});

function tailAfter(toolName: string, result: string, mode: 'structured' | 'text') {
  const after: Message[] = [
    { id: 'a1', role: 'assistant', toolCalls: [{ id: 't1', type: 'function', function: { name: toolName, arguments: '{}' } }] },
    { id: 'r1', role: 'tool', toolCallId: 't1', content: result },
  ];
  return nth(buildTail(user, after, [], mode).messages, 2).content ?? [];
}

describe('the approved-plan tool result', () => {
  it('tells the model the plan is running and the card shows each step\u2019s result', () => {
    const [block] = tailAfter('propose_plan', approved, 'structured');
    const read: unknown = JSON.parse(block?.toolResult?.content?.[0]?.text ?? '{}');

    expect(read).toStrictEqual({ ...JSON.parse(approved), next: PLAN_APPROVED_NEXT });
    expect(PLAN_APPROVED_NEXT).toMatch(/running.*plan card above shows each step.s result/s);
    expect(PLAN_APPROVED_NEXT).toMatch(/Do not say you have not seen any results/);
  });

  it('carries the same sentence in the text rendering', () => {
    const [block] = tailAfter('propose_plan', approved, 'text');

    expect(block?.text).toContain(PLAN_APPROVED_NEXT);
  });

  it.each([
    ['a declined plan', 'propose_plan', JSON.stringify({ status: 'declined' })],
    ['a failed plan', 'propose_plan', JSON.stringify({ status: 'failed', error: 'no' })],
    ['another executed write', 'create_project', approved],
    ['a result that is not JSON', 'propose_plan', 'plain text'],
  ])('leaves %s unchanged', (_label, toolName, text) => {
    expect(annotatePlanOutcome(toolName, text)).toBe(text);
  });
});
