/**
 * @persona / @all / #document through a whole run: mentions are refused off a project page,
 * the persona round runs before the model's turn (its events first, then the model's), and its
 * `<mentions>` block reaches the model as data in the newest user turn. The model's own turn is
 * unchanged otherwise (its toolset and mode are not touched by the round).
 */
import { describe, it, expect } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { nth } from '../../lib/nth-fixtures.js';
import { runBody } from './__fixtures__/fakes.js';
import { finished, harness, run, silenceConsole } from './__fixtures__/harness.js';
import type { PersonaRoundInput } from './persona-round.js';

const PROJECT_PAGE = { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' };

function body(page: Record<string, unknown>, mentions: unknown): Record<string, unknown> {
  return runBody({
    forwardedProps: { page, mentions },
    messages: [{ id: 'u1', role: 'user', content: '@all please review #PR/FAQ (v1)' }],
  });
}

function textOfBlocks(blocks: unknown): string {
  return Array.isArray(blocks) ? blocks.map((block: unknown) => JSON.stringify(block)).join('\n') : '';
}

silenceConsole();

describe('runAssistant — mentions', () => {
  it('runs the persona round before the model and hands the model its <mentions> block', async () => {
    const h = harness([{ text: 'Both personas like the price section.' }]);
    const seen: PersonaRoundInput[] = [];
    h.deps.personaRound = (input) => {
      seen.push(input);
      input.ctx.emit({ type: EventType.STEP_STARTED, stepName: 'persona:Pat' } satisfies BaseEvent);
      return Promise.resolve('<mentions>\nPersona answers\n</mentions>');
    };
    const mentions = { personas: 'all', documents: [{ document_id: 'd1', version: 1 }] };
    const events = await run(body(PROJECT_PAGE, mentions), h);

    expect(seen.map((input) => ({ mentions: input.mentions, question: input.question }))).toStrictEqual([
      { mentions, question: '@all please review #PR/FAQ (v1)' },
    ]);
    const stepAt = events.findIndex((event) => event.type === EventType.STEP_STARTED);
    const textAt = events.findIndex((event) => event.type === EventType.TEXT_MESSAGE_START);
    const userTurn = nth(h.calls, 0).messages.at(-1);
    expect({ roundFirst: stepAt > -1 && stepAt < textAt, role: userTurn?.role, block: textOfBlocks(userTurn?.content).includes('<mentions>') })
      .toStrictEqual({ roundFirst: true, role: 'user', block: true });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('refuses mentions off a project page before any model call', async () => {
    const h = harness([{ text: 'never' }]);
    h.deps.personaRound = () => Promise.reject(new Error('must not run'));
    const events = await run(body({ kind: 'dashboard', path: '/' }, { personas: 'all' }), h);
    expect(h.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expect.stringContaining('only available on a project page') });
  });

  it.each([
    ['seven persona ids', { personas: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    ['four documents', { documents: [1, 2, 3, 4].map((n) => ({ document_id: `d${String(n)}` })) }],
    ['a persona keyword other than all', { personas: 'everyone' }],
  ])('rejects %s', async (_label, mentions) => {
    const h = harness([{ text: 'never' }]);
    const events = await run(body(PROJECT_PAGE, mentions), h);
    expect(h.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expect.stringContaining('Invalid forwardedProps at mentions') });
  });

  it('adds no block and no round when the message mentions nothing', async () => {
    const h = harness([{ text: 'Hello.' }]);
    h.deps.personaRound = () => Promise.reject(new Error('must not run'));
    await run(runBody({ forwardedProps: { page: PROJECT_PAGE } }), h);
    expect(textOfBlocks(nth(h.calls, 0).messages.at(-1)?.content)).not.toContain('<mentions>');
  });
});
