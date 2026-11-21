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

/** A run refused before any model call, its last event the RUN_ERROR that says `message`. */
async function expectRefused(page: Record<string, unknown>, mentions: unknown, message: string,
  prepare: (h: ReturnType<typeof harness>) => void = () => undefined): Promise<void> {
  const h = harness([{ text: 'never' }]);
  prepare(h);
  const events = await run(body(page, mentions), h);
  expect(h.calls).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expect.stringContaining(message) });
}

const OFF_PROJECT = 'only available on a project page';
const INVALID = 'Invalid forwardedProps at mentions';

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
    await expectRefused({ kind: 'dashboard', path: '/' }, { personas: 'all' }, OFF_PROJECT, (h) => {
      h.deps.personaRound = () => Promise.reject(new Error('must not run'));
    });
  });

  it.each([
    ['seven persona ids', { personas: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    ['four documents', { documents: [1, 2, 3, 4].map((n) => ({ document_id: `d${String(n)}` })) }],
    ['a persona keyword other than all', { personas: 'everyone' }],
  ])('rejects %s', async (_label, mentions) => {
    await expectRefused(PROJECT_PAGE, mentions, INVALID);
  });

  it('adds no block and no round when the message mentions nothing', async () => {
    const h = harness([{ text: 'Hello.' }]);
    h.deps.personaRound = () => Promise.reject(new Error('must not run'));
    await run(runBody({ forwardedProps: { page: PROJECT_PAGE } }), h);
    expect(textOfBlocks(nth(h.calls, 0).messages.at(-1)?.content)).not.toContain('<mentions>');
  });
});

describe('runAssistant — #slug library mentions (any page)', () => {
  const ITEM = 'lib_20261101000000_0000a001';
  const DASHBOARD = { kind: 'dashboard', path: '/' };
  const FILE = { document: { format: 'pdf' as const, name: 'Library document 1', source: { bytes: new Uint8Array([1]) } } };

  it('resolves library mentions off a project page and hands the model the block and the file', async () => {
    const h = harness([{ text: 'Sales grew [#q3-market].' }]);
    const seen: unknown[] = [];
    h.deps.personaRound = () => Promise.reject(new Error('must not run'));
    h.deps.resolveLibrary = (input) => {
      seen.push({ mentions: input.mentions, attached: input.attachedDocuments, native: input.nativeAllowed });
      return Promise.resolve({ block: '<library>\nQ3\n</library>', documents: [FILE],
        sources: [{ item_id: ITEM, slug: 'q3-market', title: 'Q3 market' }] });
    };
    const events = await run(body(DASHBOARD, { library: [{ item_id: ITEM }] }), h);

    expect(seen).toStrictEqual([{ mentions: { library: [{ item_id: ITEM }] }, attached: 0, native: true }]);
    const userTurn = nth(h.calls, 0).messages.at(-1);
    expect({ block: textOfBlocks(userTurn?.content).includes('<library>'), file: userTurn?.content?.at(-1) })
      .toStrictEqual({ block: true, file: FILE });
    const sources = events.find((event) => event.type === EventType.CUSTOM && 'name' in event
      && event.name === 'assistant.sources');
    expect(sources).toMatchObject({ value: { library: [{ item_id: ITEM, slug: 'q3-market' }] } });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('keeps persona and document mentions on a project page only, even beside a library mention', async () => {
    await expectRefused(DASHBOARD, { personas: 'all', library: [{ item_id: ITEM }] }, OFF_PROJECT);
  });

  it('runs the persona round without the library mentions on a project page', async () => {
    const h = harness([{ text: 'ok' }]);
    const rounds: PersonaRoundInput[] = [];
    h.deps.personaRound = (input) => {
      rounds.push(input);
      return Promise.resolve(undefined);
    };
    h.deps.resolveLibrary = () => Promise.resolve({ block: undefined, documents: [], sources: [] });
    await run(body(PROJECT_PAGE, { personas: 'all', library: [{ item_id: ITEM }] }), h);
    expect(rounds.map((input) => input.mentions)).toStrictEqual([{ personas: 'all' }]);
  });

  it.each([
    ['four library items', { library: [1, 2, 3, 4].map((n) => ({ item_id: `lib_2026110100000${String(n)}_0000a001` })) }],
    ['an id that is not a library id', { library: [{ item_id: 'proj_1' }] }],
  ])('rejects %s', async (_label, mentions) => {
    await expectRefused(DASHBOARD, mentions, INVALID);
  });
});
