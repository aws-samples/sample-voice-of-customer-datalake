import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../lib/errors.js';
import { CUSTOM_EVENTS, FOCUS_GROUP_TOOL_CALL_PREFIX, focusGroupEventSchema, type FocusGroup } from '../contract.js';
import type { ToolDeps } from '../tools/deps.js';
import { converseAnswer, eventsOfType as ofType, fakeContext, fakeDeps } from '../tools/test-fixtures.js';
import { MAX_RETRY_PERSONA_CHARS, storedPersonaResult } from '../session/persona-result.js';
import { createFocusGroupRunner, focusTopic } from './focus-group.js';

const PAGE = { kind: 'project' as const, path: '/projects/proj_1', projectId: 'proj_1' };
const CONTEXT_ROUTE = 'POST /projects/proj_1/chat-context';
const PACK_ROUTE = 'POST /projects/proj_1/personas/evidence-pack';
const LIBRARY_ROUTE = 'POST /projects/library/context';
const TOPIC = 'Should delivery slots be shorter?';

function persona(id: string, name: string) {
  return { sk: `PERSONA#${id}`, persona_id: id, name };
}

const CONTEXT = {
  project: { name: 'Parcels' },
  personas: [persona('pa', 'Ada Moreno'), persona('pb', 'Bea Kim'), persona('pc', 'Cy Osei')],
  documents: [{ sk: 'DOC#d1', document_id: 'd1', document_type: 'custom', title: 'Slots brief', content: 'Two-hour slots.' }],
};

function review(id: string, text: string) {
  return { feedback_id: id, text, verbatim: true, source_platform: 'web', category: 'delivery',
    sentiment_label: 'negative', date: '2026-11-19', origin: 'cited' };
}

const PACK = {
  personas: [
    { persona_id: 'pa', evidence: [review('fa1', 'Late again'), review('fa2', 'Slot missed')], fresh_since: '2026-11-18' },
    { persona_id: 'pb', evidence: [review('fb1', 'Courier rude')], fresh_since: '2026-11-18' },
    { persona_id: 'pc', evidence: [], fresh_since: '2026-11-18' },
  ],
  missing_persona_ids: [],
};

function systemText(command: ConverseCommand): string {
  return command.input.system?.map((block) => ('text' in block ? block.text : '')).join('') ?? '';
}

function userText(command: ConverseCommand): string {
  return command.input.messages?.[0]?.content?.map((block) => ('text' in block ? block.text : '')).join('') ?? '';
}

type Answerer = (command: ConverseCommand) => string;

/** Personas cite their own reviews, an invented one and another persona's; the moderator and synthesis answer too. */
const DEFAULT_ANSWERS: Answerer = (command) => {
  const system = systemText(command);
  if (system.startsWith('You moderate')) return 'What would make a shorter slot worth it?';
  if (system.startsWith('You summarise')) {
    return JSON.stringify({ agreements: ['Ada and Bea want reliability [fb:fa1] [fb:made_up]'], disagreements: ['Cy is unsure'],
      open_questions: ['Price?'] });
  }
  const name = /You are "([^"]+)"/.exec(system)?.[1] ?? '?';
  return `I am ${name}. Late again [fb:fa1], rude courier [fb:fb1], invented [fb:zzz].`;
};

function setup(group: Partial<FocusGroup> = {}, options: { answers?: Answerer; deps?: Partial<ToolDeps>;
  routes?: Record<string, unknown>; signal?: AbortSignal } = {}) {
  const commands: ConverseCommand[] = [];
  const answers = options.answers ?? DEFAULT_ANSWERS;
  const deps = fakeDeps({ [CONTEXT_ROUTE]: CONTEXT, [PACK_ROUTE]: PACK, ...options.routes }, {
    converse: (command) => {
      commands.push(command);
      return Promise.resolve(converseAnswer(answers(command)));
    },
    ...options.deps,
  });
  const focusGroup: FocusGroup = { persona_ids: ['pa', 'pb', 'pc'], rounds: 2, ...group };
  const ctx = fakeContext('project', PAGE, { props: { page: PAGE, responseLanguage: 'en' } });
  const run = () => createFocusGroupRunner(deps)({
    focusGroup, topic: TOPIC, ctx, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { run, commands, deps, ctx };
}

interface Card { persona_id: string; answer: string; round: number; citations: Array<{ feedback_id: string }> }

function cards(events: readonly BaseEvent[]): Card[] {
  return ofType(events, EventType.TOOL_CALL_RESULT).flatMap((result) => {
    const parsed = JSON.parse(String(result.content)) as { responses: Card[] };
    return parsed.responses;
  });
}

function groupEvents(events: readonly BaseEvent[]) {
  return ofType(events, EventType.CUSTOM).filter((event) => event.name === CUSTOM_EVENTS.focusGroup)
    .map((event) => focusGroupEventSchema.parse(event.value));
}

function texts(events: readonly BaseEvent[]): string[] {
  return ofType(events, EventType.TEXT_MESSAGE_CONTENT).map((event) => String(event.delta));
}

describe('a focus group', () => {
  it('asks every persona in round 1, then the moderator, then every persona in round 2, then the synthesis', async () => {
    const { run, commands, ctx } = setup();
    await run();
    const kinds = commands.map((command) => {
      const system = systemText(command);
      if (system.startsWith('You moderate')) return 'moderator';
      if (system.startsWith('You summarise')) return 'synthesis';
      return /You are "([^"]+)"/.exec(system)?.[1];
    });
    expect(kinds).toStrictEqual(['Ada Moreno', 'Bea Kim', 'Cy Osei', 'moderator', 'Ada Moreno', 'Bea Kim', 'Cy Osei',
      'synthesis']);
    const starts = ofType(ctx.events, EventType.TOOL_CALL_START);
    expect(starts.map((start) => String(start.toolCallId).slice(0, 9))).toStrictEqual([
      `${FOCUS_GROUP_TOOL_CALL_PREFIX}r1_`, `${FOCUS_GROUP_TOOL_CALL_PREFIX}r1_`, `${FOCUS_GROUP_TOOL_CALL_PREFIX}r1_`,
      `${FOCUS_GROUP_TOOL_CALL_PREFIX}r2_`, `${FOCUS_GROUP_TOOL_CALL_PREFIX}r2_`, `${FOCUS_GROUP_TOOL_CALL_PREFIX}r2_`]);
    expect({
      names: new Set(starts.map((start) => start.toolCallName)),
      // One assistant message per round: its calls share a parent.
      parents: new Set(starts.map((start) => start.parentMessageId)).size,
      cards: cards(ctx.events).map((card) => [card.persona_id, card.round]),
    }).toStrictEqual({
      names: new Set(['consult_personas']), parents: 2,
      cards: [['pa', 1], ['pb', 1], ['pc', 1], ['pa', 2], ['pb', 2], ['pc', 2]],
    });
  });

  it('keeps round 1 independent: no persona reads another persona there', async () => {
    const { run, commands } = setup();
    await run();
    const roundOne = commands.slice(0, 3).map((command) => `${systemText(command)}${userText(command)}`);
    expect(roundOne.some((text) => text.includes('<transcript>'))).toBe(false);
  });

  it('gives each persona an anonymised digest of the others from round 2: no name, no citation, not itself', async () => {
    const { run, commands } = setup();
    await run();
    const ada = userText(commands[4] as ConverseCommand);
    const digest = ada.slice(ada.indexOf('<transcript>'), ada.indexOf('</transcript>'));
    expect(['Participant 1', 'Participant 2', 'I am another participant.'].every((part) => digest.includes(part))).toBe(true);
    expect(['Participant 3', 'Ada', 'Bea', 'Cy', '[fb:'].filter((part) => digest.includes(part))).toStrictEqual([]);
    expect(userText(commands[4] as ConverseCommand)).toContain('The moderator asks: What would make a shorter slot worth it?');
  });

  it('emits the moderator\'s follow-up as its own message', async () => {
    const { run, ctx } = setup();
    await run();
    expect(texts(ctx.events)[0]).toBe('What would make a shorter slot worth it?');
  });

  it('grounds each persona on its own pack, asked as the person for the topic', async () => {
    const { run, commands, deps } = setup();
    await run();
    const pack = deps.calls.find(({ call }) => call.path.endsWith('/evidence-pack'));
    expect({ body: pack?.call.body, sub: pack?.sub }).toStrictEqual({
      body: { persona_ids: ['pa', 'pb', 'pc'], question: TOPIC, limit: 8 }, sub: 'user-sub' });
    const ada = userText(commands[0] as ConverseCommand);
    expect({ own: ada.includes('[fb:fa1]'), other: ada.includes('[fb:fb1]'), notInSystem: systemText(commands[0] as ConverseCommand).includes('[fb:') })
      .toStrictEqual({ own: true, other: false, notInSystem: false });
    expect(userText(commands[2] as ConverseCommand)).toContain('No customer review is available to you');
  });

  it('strips every citation outside the speaker\'s pack, and the synthesis\' outside every pack', async () => {
    const { run, ctx } = setup();
    await run();
    const [ada, bea, cy] = cards(ctx.events);
    expect({ ada: ada?.answer, bea: bea?.answer, cy: cy?.answer }).toStrictEqual({
      ada: 'I am Ada Moreno. Late again [fb:fa1], rude courier, invented.',
      bea: 'I am Bea Kim. Late again, rude courier [fb:fb1], invented.',
      cy: 'I am Cy Osei. Late again, rude courier, invented.',
    });
    expect(ada?.citations.map((citation) => citation.feedback_id)).toStrictEqual(['fa1']);
    const [, finished] = groupEvents(ctx.events);
    expect({ agreements: finished?.synthesis?.agreements, cited: finished?.cited_feedback_ids }).toStrictEqual({
      agreements: ['Ada and Bea want reliability [fb:fa1]'], cited: ['fa1', 'fb1'] });
  });

  it('says it is running, then finished with its synthesis; the synthesis is the last message, labelled synthetic', async () => {
    const { run, ctx } = setup();
    const outcome = await run();
    const [running, finished] = groupEvents(ctx.events);
    expect([running, finished]).toMatchObject([{ status: 'running', rounds_completed: 0, config: { rounds: 2 } },
      { status: 'finished', rounds_completed: 2 }]);
    const last = texts(ctx.events).at(-1) ?? '';
    expect({ agreements: last.includes('**Agreements**'), synthetic: last.includes('Synthetic') })
      .toStrictEqual({ agreements: true, synthetic: true });
    expect({ sources: outcome.sources.map((source) => source.feedback_id), stopped: outcome.stopped, turns: outcome.usage.turns })
      .toStrictEqual({ sources: ['fa1', 'fb1'], stopped: false, turns: 8 });
  });

  it('runs one round with no moderator', async () => {
    const { run, commands } = setup({ rounds: 1 });
    await run();
    expect(commands.map(systemText).filter((text) => text.startsWith('You moderate'))).toHaveLength(0);
    expect(commands).toHaveLength(4);
  });

  it('stops between batches: every call still gets a result, no synthesis, the event says stopped', async () => {
    const controller = new AbortController();
    const many = { ...CONTEXT, personas: [...CONTEXT.personas, persona('pd', 'Dee'), persona('pe', 'Eli')] };
    const { run, ctx, commands } = setup({ persona_ids: ['pa', 'pb', 'pc', 'pd', 'pe'] }, {
      routes: { [CONTEXT_ROUTE]: many },
      answers: (command) => {
        controller.abort();
        return DEFAULT_ANSWERS(command);
      },
      signal: controller.signal,
    });
    const outcome = await run();
    // The first batch of three answered; the other two got the stopped result.
    expect({ calls: commands.length, results: ofType(ctx.events, EventType.TOOL_CALL_RESULT).length,
      cards: cards(ctx.events).length }).toStrictEqual({ calls: 3, results: 5, cards: 3 });
    const [, stopped] = groupEvents(ctx.events);
    expect(stopped).toMatchObject({ status: 'stopped', rounds_completed: 0 });
    expect({ synthesis: stopped?.synthesis, stopped: outcome.stopped }).toStrictEqual({ synthesis: undefined, stopped: true });
  });

  it('fails open on an unreadable pack: the personas speak and cite nothing', async () => {
    const { run, ctx } = setup({}, { routes: { [PACK_ROUTE]: new ServiceError('down') } });
    await run();
    expect(cards(ctx.events).every((card) => !card.answer.includes('[fb:'))).toBe(true);
  });

  it('asks a fixed follow-up when the moderator fails, and says so when the synthesis fails', async () => {
    const { run, ctx } = setup({}, {
      answers: (command) => {
        const system = systemText(command);
        if (system.startsWith('You moderate') || system.startsWith('You summarise')) throw new ServiceError('throttled');
        return 'Fine.';
      },
    });
    await run();
    expect(texts(ctx.events)[0]).toBe('Where do you disagree with the others, and why?');
    expect(texts(ctx.events).at(-1)).toContain('could not be written');
    expect(groupEvents(ctx.events).at(-1)?.synthesis).toBeUndefined();
  });

  it('names the personas the project no longer has, and with none left asks no one', async () => {
    const { run, ctx, commands } = setup({ persona_ids: ['gone1', 'gone2'] });
    await run();
    expect(commands).toHaveLength(0);
    expect(groupEvents(ctx.events).at(-1)).toMatchObject({ status: 'finished', missing_persona_ids: ['gone1', 'gone2'] });
  });

  it('reads the tagged documents and the library items\' passages for the topic', async () => {
    const item = 'lib_20261120000000_0a1b2c3d';
    const { run, commands, deps } = setup({ documents: [{ document_id: 'd1' }], library: [{ item_id: item }] }, {
      routes: { [LIBRARY_ROUTE]: { items: [{ item_id: item, slug: 'survey', title: 'Survey' }], native: [],
        passages: [{ item_id: item, chunk: 0, page: 2, text: 'Most want two-hour slots.' }], missing: 0, pending: [] } },
    });
    const outcome = await run();
    const ada = systemText(commands[0] as ConverseCommand);
    expect({ document: ada.includes('Two-hour slots.'), library: ada.includes('[#survey p.2]') })
      .toStrictEqual({ document: true, library: true });
    expect(deps.calls.find(({ call }) => call.path === '/projects/library/context')?.call.body)
      .toMatchObject({ item_ids: [item], native_slots: 0, query: TOPIC });
    expect(outcome.librarySources).toStrictEqual([{ item_id: item, slug: 'survey', title: 'Survey', page: 2 }]);
  });

  it('stores each card as valid JSON with its round and citations, even when its answer is cut to fit', async () => {
    const long = 'x'.repeat(5000);
    const { run, ctx } = setup({ rounds: 1 }, { answers: (command) => (systemText(command).startsWith('You summarise')
      ? '{}' : `[fb:fa1] ${long}`) });
    await run();
    const [first] = ofType(ctx.events, EventType.TOOL_CALL_RESULT);
    const stored = storedPersonaResult(String(first?.content), MAX_RETRY_PERSONA_CHARS) ?? '';
    const parsed = JSON.parse(stored) as { responses: Card[] };
    expect({ length: stored.length <= MAX_RETRY_PERSONA_CHARS, round: parsed.responses[0]?.round,
      cited: parsed.responses[0]?.citations.map((citation) => citation.feedback_id) })
      .toStrictEqual({ length: true, round: 1, cited: ['fa1'] });
  });

  it('needs a topic of at most 2,000 characters', () => {
    expect(() => focusTopic('  ')).toThrow('needs a topic');
    expect(() => focusTopic('x'.repeat(2001))).toThrow('at most 2000');
    expect(focusTopic(' Why? ')).toBe('Why?');
  });
});
