import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../lib/errors.js';
import { nth } from '../../lib/nth-fixtures.js';
import { MENTION_TOOL_CALL_PREFIX } from '../contract.js';
import type { ToolDeps } from '../tools/deps.js';
import { converseAnswer, fakeContext, fakeDeps } from '../tools/test-fixtures.js';
import { createPersonaRound } from './persona-round.js';

const ROUTE = 'POST /projects/proj_1/chat-context';
const PAGE = { kind: 'project' as const, path: '/projects/proj_1', projectId: 'proj_1' };

function persona(index: number) {
  return { sk: `PERSONA#p${String(index)}`, persona_id: `p${String(index)}`, name: `Persona ${String(index)}` };
}

const CONTEXT = {
  project: { sk: 'META', name: 'Checkout' },
  personas: [persona(1), persona(2)],
  documents: [{ sk: 'PRFAQ#d1', document_id: 'd1', document_type: 'prfaq', title: 'Fast checkout', version: 1, content: 'One tap.' }],
};

function answer(text: string): ConverseCommandOutput {
  return converseAnswer(text);
}

function systemText(command: ConverseCommand): string {
  return command.input.system?.map((block) => ('text' in block ? block.text : '')).join('') ?? '';
}

/** Answers "I am <persona name>." so each result can be traced to its persona. */
function setup(context: unknown = CONTEXT, overrides: Partial<ToolDeps> = {}) {
  const commands: ConverseCommand[] = [];
  const deps = fakeDeps({ [ROUTE]: context }, {
    converse: (command) => {
      commands.push(command);
      const name = /You are "([^"]+)"/.exec(systemText(command))?.[1] ?? '?';
      return Promise.resolve(answer(`I am ${name}.`));
    },
    ...overrides,
  });
  return { round: createPersonaRound(deps), commands, deps, ctx: fakeContext('project', PAGE) };
}

function ofType(events: readonly BaseEvent[], type: EventType): Record<string, unknown>[] {
  return events.filter((event) => event.type === type).map((event) => ({ ...event }));
}

describe('persona round', () => {
  const TAGGED = { personas: ['p2'], documents: [{ document_id: 'd1', version: 1 }] };
  const QUESTION = '@Persona 2 review #Fast checkout';

  it('answers a mentioned persona as its own consult_personas call with valid tool arguments', async () => {
    const { round, ctx } = setup();
    await round({ mentions: TAGGED, question: QUESTION, ctx });
    const starts = ofType(ctx.events, EventType.TOOL_CALL_START);
    const results = ofType(ctx.events, EventType.TOOL_CALL_RESULT);
    expect({
      names: starts.map((start) => start.toolCallName),
      prefixed: starts.every((start) => String(start.toolCallId).startsWith(MENTION_TOOL_CALL_PREFIX)),
      args: ofType(ctx.events, EventType.TOOL_CALL_ARGS).map((event): unknown => JSON.parse(String(event.delta))),
      answeredCall: results.map((result) => result.toolCallId),
    }).toStrictEqual({
      names: ['consult_personas'],
      prefixed: true,
      args: [{ question: QUESTION, document_ids: ['d1'], persona_ids: ['p2'] }],
      answeredCall: starts.map((start) => start.toolCallId),
    });
    expect(results.map((result): unknown => JSON.parse(String(result.content)))).toStrictEqual([
      { responses: [{ persona_id: 'p2', name: 'Persona 2', answer: 'I am Persona 2.' }] },
    ]);
  });

  it('grounds the persona on the tagged document text', async () => {
    const { round, commands, ctx, deps } = setup();
    await round({ mentions: TAGGED, question: QUESTION, ctx });
    expect(deps.calls.map(({ call }) => call.body)).toStrictEqual([{ selected_document_ids: ['d1'] }]);
    expect(commands).toHaveLength(1);
    expect(systemText(nth(commands, 0))).toContain('One tap.');
  });

  it('hands the model the answers and the tagged documents as a <mentions> block', async () => {
    const { round, ctx } = setup();
    const block = await round({ mentions: TAGGED, question: QUESTION, ctx }) ?? '';
    expect([
      '<mentions>',
      '"Fast checkout (v1)" (document_id "d1")',
      '### "Persona 2" (persona_id "p2")\nI am Persona 2.',
      'Add a short synthesis',
    ].filter((part) => !block.includes(part))).toStrictEqual([]);
  });

  it('asks only the first six personas for @all and names the ones left out', async () => {
    const many = { ...CONTEXT, personas: Array.from({ length: 8 }, (_, i) => persona(i + 1)) };
    const { round, commands, ctx } = setup(many);
    const block = await round({ mentions: { personas: 'all' }, question: '@all thoughts?', ctx });

    expect(commands).toHaveLength(6);
    expect(ofType(ctx.events, EventType.TOOL_CALL_RESULT)).toHaveLength(6);
    expect(block).toContain('Not asked (at most 6 personas per message; tell the user): "Persona 7", "Persona 8".');
  });

  it('puts every call of the round on one assistant message', async () => {
    const { round, ctx } = setup();
    await round({ mentions: { personas: 'all' }, question: 'q', ctx });
    const parents = new Set(ofType(ctx.events, EventType.TOOL_CALL_START).map((start) => start.parentMessageId));
    expect(parents.size).toBe(1);
  });

  it('reports mentioned personas and documents that no longer exist instead of failing', async () => {
    const { round, commands, ctx } = setup();
    const block = await round({ mentions: { personas: ['p1', 'gone', 'p1'], documents: [{ document_id: 'old' }] }, question: 'q', ctx });
    expect(commands).toHaveLength(1);
    expect(block).toContain('Mentioned personas no longer in the project: "gone".');
    expect(block).toContain('Tagged documents no longer in the project: "old".');
  });

  it('only names tagged documents when no persona was mentioned', async () => {
    const { round, commands, ctx } = setup();
    const block = await round({ mentions: { documents: [{ document_id: 'd1' }] }, question: 'summarise #Fast checkout', ctx });
    expect(commands).toHaveLength(0);
    expect(ctx.events).toStrictEqual([]);
    expect(block).toContain('read them with get_documents');
  });

  it('fails open with a note when the project cannot be read', async () => {
    const { round, ctx } = setup(new ServiceError('boom'));
    const block = await round({ mentions: { personas: 'all' }, question: 'q', ctx });
    expect(ctx.events).toStrictEqual([]);
    expect(block).toContain('The personas could not be asked: the project could not be read right now.');
  });

  it('answers every call even when the user stops mid-round', async () => {
    const many = { ...CONTEXT, personas: Array.from({ length: 5 }, (_, i) => persona(i + 1)) };
    const controller = new AbortController();
    const { round, ctx } = setup(many, {
      converse: () => {
        controller.abort();
        return Promise.resolve(answer('first batch'));
      },
    });
    await round({ mentions: { personas: 'all' }, question: 'q', ctx, signal: controller.signal });
    const contents = ofType(ctx.events, EventType.TOOL_CALL_RESULT).map((result): unknown => JSON.parse(String(result.content)));
    expect(contents).toHaveLength(5);
    expect(contents.slice(3)).toStrictEqual([
      { responses: [], note: 'Stopped before this persona answered.' },
      { responses: [], note: 'Stopped before this persona answered.' },
    ]);
  });

  it('uses a default question when the message has no text', async () => {
    const { round, commands, ctx } = setup();
    await round({ mentions: { personas: ['p1'] }, question: '   ', ctx });
    expect(commands[0]?.input.messages?.[0]?.content?.[0]?.text).toContain('What do you think?');
  });
});
