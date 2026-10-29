import { describe, expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { buildSessionItem } from './record.js';
import { MAX_STORED_PERSONA_CHARS, storedPersonaResult } from './persona-result.js';
import { PERSONA_RESULT_CASES, PERSONA_RESULT_LOCKSTEP_INPUTS, SIX_LONG_ANSWERS } from './persona-result-fixtures.js';

const snapshotBase = {
  callerSub: 'sub-1', threadId: 'thread-1', runId: 'run-1', status: 'finished' as const,
  page: { kind: 'project' as const, path: '/projects/p' }, pendingInterrupts: [], createdAt: 'c', updatedAt: 'u', revision: 1,
};

describe('storedPersonaResult', () => {
  it.each(PERSONA_RESULT_CASES)('$name', ({ text, budget, expected }) => {
    expect(storedPersonaResult(text, budget)).toBe(expected);
  });

  const personaInputs = PERSONA_RESULT_LOCKSTEP_INPUTS.filter(({ text, budget }) => budget >= 1000 && storedPersonaResult(text, budget) !== null);

  it.each(personaInputs)('stores a persona result within $budget characters as valid JSON', ({ text, budget }) => {
    const stored = storedPersonaResult(text, budget) ?? '';
    expect({ fits: stored.length <= budget, json: typeof JSON.parse(stored) }).toStrictEqual({ fits: true, json: 'object' });
  });

  it('stays valid JSON even when the names alone exceed the budget', () => {
    const stored = storedPersonaResult(SIX_LONG_ANSWERS, 100) ?? '';
    expect((): unknown => JSON.parse(stored)).not.toThrow();
  });

  it('keeps every card readable after the cut, within the budget', () => {
    const stored = storedPersonaResult(SIX_LONG_ANSWERS, 6000) ?? '';
    const parsed: unknown = JSON.parse(stored);
    expect(stored.length).toBeLessThanOrEqual(6000);
    expect(parsed).toMatchObject({ responses: Array.from({ length: 6 }, () => ({ answer: expect.stringMatching(/…$/) })) });
  });
});

describe('a stored session with a long persona round', () => {
  it('keeps the persona cards as valid JSON (they used to vanish after a reload)', () => {
    const long = JSON.stringify({ responses: [{ persona_id: 'p1', name: 'Pat', avatar_url: 'https://cdn.example/a.png', answer: 'x'.repeat(4000) }] });
    const messages: Message[] = [
      { id: 'u', role: 'user', content: '@Pat review' },
      { id: 'a', role: 'assistant', toolCalls: [{ id: 'mention_1', type: 'function', function: { name: 'consult_personas', arguments: '{}' } }] },
      { id: 't', role: 'tool', toolCallId: 'mention_1', content: long },
    ];
    const item = buildSessionItem({ ...snapshotBase, messages });
    const stored: unknown = JSON.parse(String(item?.messages_json));
    expect(long.length).toBeGreaterThan(4000);
    expect(long.length).toBeLessThan(MAX_STORED_PERSONA_CHARS);
    expect(stored).toMatchObject([{}, {}, { content: long }]);
  });

  it('still cuts any other long tool result to 4,000 characters', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'q' },
      { id: 'a', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search_feedback', arguments: '{}' } }] },
      { id: 't', role: 'tool', toolCallId: 'c1', content: 'y'.repeat(5000) },
    ];
    const stored: unknown = JSON.parse(String(buildSessionItem({ ...snapshotBase, messages })?.messages_json));
    expect(stored).toMatchObject([{}, {}, { content: 'y'.repeat(4000) }]);
  });
});
