/**
 * Mutation hardening of the session recorder (recorder.ts).
 *
 * The run-level tests saw only well-formed runs with one assistant message and
 * at most one tool call, so Stryker found that nothing pinned: TOOL_CALL_ARGS
 * concatenation (and which call/message it lands on), the reasoning
 * encrypted value, the exact tool-call shape and its parent fallbacks, how a
 * non-string tool result is stored, navigation events, which message carries
 * the sources, the interrupt/finished outcome rules, malformed events being
 * ignored, and that a terminal run queues no further write.
 */
import { describe, it, expect } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { CUSTOM_EVENTS } from '../contract.js';
import { createSessionRecorder } from './recorder.js';
import type { SessionWriter } from './writer.js';

const START_MS = 1_700_000_000_000;

/** A recorder whose writer keeps every built item; the clock never advances, so only events flush. */
function record() {
  const written: Record<string, unknown>[] = [];
  const writer: SessionWriter = {
    enqueue(build) {
      const revision = written.length + 10;
      const item = build(revision);
      if (item !== null) written.push(item);
      return revision;
    },
    settled: () => Promise.resolve(),
  };
  const recorder = createSessionRecorder({
    callerSub: 'sub-9', threadId: 'thread-9', runId: 'run-9', page: { kind: 'dashboard', path: '/' },
    history: [{ id: 'h1', role: 'user', content: 'question' }], createdAt: 'created',
  }, writer, () => START_MS);
  const lastItem = (): Record<string, unknown> => {
    const item = written.at(-1);
    if (item === undefined) throw new RangeError('nothing written');
    return item;
  };
  /** Flush and return the run's output (the history message dropped). */
  const output = (): unknown => {
    recorder.flush();
    const parsed: unknown = JSON.parse(String(lastItem().messages_json));
    return Array.isArray(parsed) ? parsed.slice(1) : parsed;
  };
  const feed = (...events: BaseEvent[]): (number | null)[] => events.map((e) => recorder.observe(e));
  return { written, recorder, lastItem, output, feed };
}

const textStart = (messageId: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_START, messageId });
const text = (messageId: string, delta: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
const toolStart = (toolCallId: string, parentMessageId?: string): BaseEvent => ({
  type: EventType.TOOL_CALL_START, toolCallId, toolCallName: `tool_${toolCallId}`, ...(parentMessageId ? { parentMessageId } : {}),
});
const args = (toolCallId: string, delta: string): BaseEvent => ({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta });
const result = (messageId: string, content: unknown): BaseEvent => ({ type: EventType.TOOL_CALL_RESULT, messageId, toolCallId: 'c1', content });
const customEvent = (name: string, value: unknown): BaseEvent => ({ type: EventType.CUSTOM, name, value });
const finishedEvent = (outcome?: unknown): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: 'thread-9', runId: 'run-9', ...(outcome ? { outcome } : {}) });
const call = (id: string, argsText: string) => ({ id, type: 'function', function: { name: `tool_${id}`, arguments: argsText } });

describe('the first write is the history alone', () => {
  it('stores the exact item before any event', () => {
    const { recorder, lastItem } = record();
    expect(recorder.flush()).toBe(10);
    expect(lastItem()).toStrictEqual({
      pk: 'USER#sub-9', sk: 'CONV#thread-9', conversation_id: 'thread-9', kind: 'assistant', title: 'question',
      messages_json: '[{"id":"h1","role":"user","content":"question"}]', page_json: '{"kind":"dashboard","path":"/"}',
      pending_json: '[]', message_count: 1, created_at: 'created', updated_at: new Date(START_MS).toISOString(),
      run_id: 'run-9', run_status: 'running', revision: 10,
    });
  });
});

describe('text lands on its own assistant message', () => {
  it('creates the message on its first content event and keeps two messages apart', () => {
    const { feed, output } = record();
    expect(feed(text('a1', 'one'), text('a2', 'tw'), text('a2', 'o'))).toStrictEqual([null, null, null]);
    expect(output()).toStrictEqual([
      { id: 'a1', role: 'assistant', content: 'one' },
      { id: 'a2', role: 'assistant', content: 'two' },
    ]);
  });

  it('never turns a tool message with the same id into text', () => {
    const { feed, output } = record();
    feed(result('m1', 'r'), textStart('m1'), text('m1', 'hi'), customEvent(CUSTOM_EVENTS.sources, { web: [] }));
    expect(output()).toStrictEqual([{ id: 'm1', role: 'tool', toolCallId: 'c1', content: 'r' }]);
  });
});

describe('tool calls', () => {
  it('stores each call exactly and concatenates its argument deltas on the right call', () => {
    const { feed, output } = record();
    feed(
      text('a1', 'Looking.'), toolStart('c1', 'a2'), toolStart('c2', 'a2'), result('t1', 'ok'),
      args('c2', '{"q":'), args('c2', '"late"}'), args('c1', '{}'),
    );
    expect(output()).toStrictEqual([
      { id: 'a1', role: 'assistant', content: 'Looking.' },
      { id: 'a2', role: 'assistant', content: '', toolCalls: [call('c1', '{}'), call('c2', '{"q":"late"}')] },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'ok' },
    ]);
  });

  it('attaches a parentless call to the last assistant message', () => {
    const { feed, output } = record();
    feed(textStart('a1'), toolStart('c1'), args('c1', '{"k":1}'));
    expect(output()).toStrictEqual([{ id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', '{"k":1}')] }]);
  });

  it('prefers the named parent over the last assistant message', () => {
    const { feed, output } = record();
    feed(textStart('a1'), toolStart('c1', 'p1'));
    expect(output()).toStrictEqual([
      { id: 'a1', role: 'assistant', content: '' },
      { id: 'p1', role: 'assistant', content: '', toolCalls: [call('c1', '')] },
    ]);
  });

  it('opens assistant-{id} for a parentless call with no assistant yet', () => {
    const { feed, output } = record();
    feed(toolStart('c7'));
    expect(output()).toStrictEqual([{ id: 'assistant-c7', role: 'assistant', content: '', toolCalls: [call('c7', '')] }]);
  });

  it.each([
    ['an object', { n: 1 }, '{"n":1}'],
    ['null', null, '""'],
    ['a string', 'plain', 'plain'],
  ])('stores %s tool result as %s', (_label, content, stored) => {
    const { feed, output } = record();
    expect(feed(result('t1', content))).toStrictEqual([10]);
    expect(output()).toStrictEqual([{ id: 't1', role: 'tool', toolCallId: 'c1', content: stored }]);
  });
});

describe('reasoning, sources and navigation', () => {
  it('stores the encrypted reasoning of a message, opening it when needed', () => {
    const { feed, output } = record();
    feed(
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'a1', encryptedValue: 'enc' },
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'tool-call', entityId: 'c1', encryptedValue: 'skip' },
      customEvent(CUSTOM_EVENTS.sources, { feedback: [] }),
    );
    expect(output()).toStrictEqual([
      { id: 'a1', role: 'assistant', content: '', encryptedValue: 'enc', metadata: { voc: { sources: { feedback: [] } } } },
    ]);
  });

  it('puts sources and navigation only on the last assistant message', () => {
    const { feed, output } = record();
    feed(
      text('a1', 'x'), text('a2', 'y'),
      customEvent(CUSTOM_EVENTS.sources, { web: ['s'] }),
      customEvent(CUSTOM_EVENTS.navigation, { path: '/a' }), customEvent(CUSTOM_EVENTS.navigation, { path: '/b' }),
      customEvent('assistant.other', 'ignored'),
    );
    expect(output()).toStrictEqual([
      { id: 'a1', role: 'assistant', content: 'x' },
      { id: 'a2', role: 'assistant', content: 'y', metadata: { voc: { sources: { web: ['s'] }, navigation: [{ path: '/a' }, { path: '/b' }] } } },
    ]);
  });

  it('stores navigation alone without a sources key', () => {
    const { feed, output } = record();
    feed(text('a1', 'x'), customEvent(CUSTOM_EVENTS.navigation, { path: '/n' }));
    expect(output()).toStrictEqual([{ id: 'a1', role: 'assistant', content: 'x', metadata: { voc: { navigation: [{ path: '/n' }] } } }]);
  });

  it('stores sources alone without a navigation key', () => {
    const { feed, output } = record();
    feed(text('a1', 'x'), customEvent(CUSTOM_EVENTS.sources, 's'));
    expect(output()).toStrictEqual([{ id: 'a1', role: 'assistant', content: 'x', metadata: { voc: { sources: 's' } } }]);
  });
});

describe('malformed events change nothing and queue nothing', () => {
  it.each([
    ['TEXT_MESSAGE_START', { type: EventType.TEXT_MESSAGE_START }],
    ['TEXT_MESSAGE_CONTENT', { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a9' }],
    ['TOOL_CALL_START', { type: EventType.TOOL_CALL_START, toolCallId: 'c9' }],
    ['TOOL_CALL_ARGS', { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1' }],
    ['TOOL_CALL_RESULT', { type: EventType.TOOL_CALL_RESULT, toolCallId: 'c1' }],
    ['REASONING_ENCRYPTED_VALUE', { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message' }],
    ['CUSTOM', { type: EventType.CUSTOM, value: 'v' }],
  ])('%s', (_label, event: BaseEvent) => {
    const { feed, output, written } = record();
    feed(textStart('a1'), toolStart('c1'));
    expect(feed(event)).toStrictEqual([null]);
    expect(written).toHaveLength(0);
    expect(output()).toStrictEqual([{ id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', '')] }]);
  });
});

describe('the terminal status', () => {
  it.each([
    ['no outcome', undefined, 'finished', '[]'],
    ['success with stray interrupts', { type: 'success', interrupts: [{ id: 'i' }] }, 'finished', '[]'],
    ['an interrupt without interrupts', { type: 'interrupt' }, 'finished', '[]'],
    ['an interrupt', { type: 'interrupt', interrupts: [{ id: 'i1' }] }, 'interrupted', '[{"id":"i1"}]'],
  ])('%s → %s', (_label, outcome, status, pending) => {
    const { feed, lastItem } = record();
    expect(feed(finishedEvent(outcome))).toStrictEqual([10]);
    expect(lastItem()).toMatchObject({ run_status: status, pending_json: pending });
  });

  it('queues nothing once the run has failed', () => {
    const { feed, written } = record();
    expect(feed({ type: EventType.RUN_ERROR, message: 'boom' }, { type: EventType.TOOL_CALL_END, toolCallId: 'c1' }, finishedEvent())).toStrictEqual([10, null, null]);
    expect(written.map((i) => i.run_status)).toStrictEqual(['failed']);
  });
});
