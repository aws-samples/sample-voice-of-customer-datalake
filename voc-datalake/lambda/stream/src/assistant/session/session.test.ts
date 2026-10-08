/**
 * Server-side session persistence: the stream Lambda saves the conversation
 * (user turn + the in-progress assistant turn) to the caller's own
 * conversations partition WHILE the run streams, so a reload mid-answer finds
 * it (QA s1 F3, perf §4).
 */
import { describe, it, expect, vi } from 'vitest';
import type { BaseEvent, Message } from '@ag-ui/core';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { EventType } from '@ag-ui/core';
import { ServiceError } from '../../lib/errors.js';
import { runAssistant, type RuntimeDeps } from '../runtime/run.js';
import { parseLambdaEvent } from '../runtime/event.js';
import { failingStream, lambdaEvent, recordingEmitter, runBody } from '../runtime/__fixtures__/fakes.js';
import { harness, silenceConsole, types } from '../runtime/__fixtures__/harness.js';
import { createSessionRecorder, THROTTLE_MS, THROTTLE_CHARS } from './recorder.js';
import { buildSessionItem, MAX_ITEM_BYTES, estimatedItemBytes } from './record.js';
import { createSessionWriter, SESSION_WRITE_FAILED_METRIC, type PutOutcome } from './writer.js';
import { createDynamoSessionStore, type SessionStore, type StoredSession } from './store.js';
import { mergeHistory } from './run-session.js';

silenceConsole();

interface Put { callerSub: string; item: Record<string, unknown>; revision: number }

function fakeStore(options: { stored?: StoredSession | null; fail?: boolean } = {}): SessionStore & { puts: Put[]; loads: string[][] } {
  const puts: Put[] = [];
  const loads: string[][] = [];
  return {
    puts,
    loads,
    load: async (callerSub, threadId) => {
      loads.push([callerSub, threadId]);
      return options.stored ?? null;
    },
    put: async (callerSub, item, revision) => {
      if (options.fail) throw new ServiceError('ProvisionedThroughputExceeded');
      puts.push({ callerSub, item, revision });
      return 'written';
    },
  };
}

function messagesOf(item: Record<string, unknown>): Message[] {
  const raw = item.messages_json;
  if (typeof raw !== 'string') throw new TypeError('messages_json missing');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new TypeError('messages_json is not a list');
  return parsed.filter((m): m is Message => typeof m === 'object' && m !== null && 'role' in m);
}

function lastPut(store: { puts: Put[] }): Put {
  const put = store.puts.at(-1);
  if (!put) throw new ServiceError('no session write');
  return put;
}

async function runWith(deps: RuntimeDeps, body = runBody(), claims?: Record<string, string>) {
  const { emitter, events } = recordingEmitter();
  const { persisted } = await runAssistant(parseLambdaEvent(lambdaEvent(body, claims)), emitter, deps);
  await persisted;
  return events;
}

const clock = { ms: 1_800_000_000_000 };
const nowMs = () => clock.ms;

describe('the run persists its conversation while it streams', () => {
  it('saves the user turn as running first, then the finished answer', async () => {
    const store = fakeStore();
    const h = harness([{ text: 'Mostly happy.' }]);
    await runWith({ ...h.deps, sessions: { store, nowMs } });

    const first = store.puts.at(0);
    expect(first?.item).toMatchObject({ run_status: 'running', run_id: 'run-1', kind: 'assistant', conversation_id: 'thread-1' });
    expect(first && messagesOf(first.item).map((m) => m.role)).toStrictEqual(['user']);
    const final = lastPut(store);
    expect(final.item).toMatchObject({ run_status: 'finished', title: 'How are customers feeling?', message_count: 2 });
    expect(messagesOf(final.item).at(-1)).toMatchObject({ role: 'assistant', content: 'Mostly happy.' });
  });

  it('tells the client the final revision just before RUN_FINISHED', async () => {
    const store = fakeStore();
    const events = await runWith({ ...harness([{ text: 'x' }]).deps, sessions: { store, nowMs } });

    expect(types(events).slice(-2)).toStrictEqual(['CUSTOM:assistant.session', 'RUN_FINISHED']);
    expect(events.at(-2)).toMatchObject({ value: { revision: lastPut(store).revision } });
  });

  it('stores an approval stop as interrupted, with its pending interrupts', async () => {
    const store = fakeStore();
    const h = harness([{ toolUses: [{ id: 'tc1', name: 'create_project', input: { name: 'Checkout' } }] }]);
    await runWith({ ...h.deps, sessions: { store, nowMs } });

    const final = lastPut(store);
    expect(final.item.run_status).toBe('interrupted');
    expect(JSON.parse(String(final.item.pending_json))).toMatchObject([{ toolCallId: 'tc1', reason: 'tool_approval' }]);
    expect(messagesOf(final.item).at(-1)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'tc1' }] });
  });

  it('stores a failed run as failed', async () => {
    const store = fakeStore();
    const h = harness([]);
    const deps: RuntimeDeps = { ...h.deps, converse: () => failingStream(new ServiceError('boom')), sessions: { store, nowMs } };
    const events = await runWith(deps);

    expect(types(events).at(-1)).toBe('RUN_ERROR');
    expect(lastPut(store).item.run_status).toBe('failed');
  });

  it('records server tool calls and their (trimmed) results', async () => {
    const store = fakeStore();
    const h = harness([{ toolUses: [{ id: 't1', name: 'search_feedback', input: { query: 'late' } }] }, { text: 'Delivery.' }]);
    await runWith({ ...h.deps, sessions: { store, nowMs } });

    const roles = messagesOf(lastPut(store).item).map((m) => m.role);
    expect(roles).toStrictEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messagesOf(lastPut(store).item)[2]).toMatchObject({ toolCallId: 't1', content: 'Found 3 complaints about delivery' });
  });

  it('survives every write failing: the stream is complete and the failure is counted', async () => {
    const log = vi.spyOn(console, 'log');
    const store = fakeStore({ fail: true });
    const events = await runWith({ ...harness([{ text: 'still answered' }]).deps, sessions: { store, nowMs } });

    expect(types(events)).toContain('TEXT_MESSAGE_CONTENT');
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
    expect(log.mock.calls.some(([line]) => String(line).includes(SESSION_WRITE_FAILED_METRIC))).toBe(true);
  });

  it('does not save at all when persistence is not configured', async () => {
    const events = await runWith(harness([{ text: 'x' }]).deps);
    expect(types(events)).not.toContain('CUSTOM:assistant.session');
  });
});

describe('the partition is always the verified caller', () => {
  it('reads and writes only USER#{authorizer sub}, whatever the body claims', async () => {
    const store = fakeStore();
    const body = runBody({
      forwardedProps: { page: { kind: 'dashboard', path: '/' }, sub: 'victim' },
      state: { sub: 'victim', userId: 'victim' },
    });
    await runWith({ ...harness([{ text: 'x' }]).deps, sessions: { store, nowMs } }, body, { sub: 'caller-sub' });

    expect(store.loads).toStrictEqual([['caller-sub', 'thread-1']]);
    expect(store.puts.length).toBeGreaterThan(0);
    for (const put of store.puts) {
      expect(put.callerSub).toBe('caller-sub');
      expect(put.item).toMatchObject({ pk: 'USER#caller-sub', sk: 'CONV#thread-1' });
    }
  });

  it('the DynamoDB store keys every read and conditional write by the caller, and refuses another partition', async () => {
    const sent: unknown[] = [];
    const client = { send: vi.fn(async (command: GetCommand | PutCommand) => {
      sent.push(command.input);
      return command instanceof GetCommand ? { Item: { created_at: '2026-01-01T00:00:00Z', messages_json: '[]' } } : {};
    }) };
    const store = createDynamoSessionStore(client, 'conv-table');

    await store.load('caller-sub', 'thread-1');
    await store.put('caller-sub', { pk: 'USER#caller-sub', sk: 'CONV#thread-1' }, 7);
    await expect(store.put('caller-sub', { pk: 'USER#other', sk: 'CONV#thread-1' }, 8)).rejects.toThrow(/partition/);

    expect(sent).toStrictEqual([
      expect.objectContaining({ TableName: 'conv-table', Key: { pk: 'USER#caller-sub', sk: 'CONV#thread-1' } }),
      expect.objectContaining({
        Item: { pk: 'USER#caller-sub', sk: 'CONV#thread-1' },
        ConditionExpression: 'attribute_not_exists(#rev) OR #rev < :rev',
        ExpressionAttributeValues: { ':rev': 7 },
      }),
    ]);
  });

  it('reports a refused conditional write as superseded, not as a failure', async () => {
    const refusal = new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    const store = createDynamoSessionStore({ send: async () => Promise.reject(refusal) }, 't');
    await expect(store.put('a', { pk: 'USER#a' }, 1)).resolves.toBe('superseded');
  });
});

describe('throttling (fake clock)', () => {
  function recorderWith() {
    const items: Record<string, unknown>[] = [];
    const writer = { enqueue: (build: (revision: number) => Record<string, unknown> | null) => {
      const item = build(items.length + 1);
      if (item) items.push(item);
      return items.length;
    }, settled: async () => {} };
    const recorder = createSessionRecorder({
      callerSub: 's', threadId: 't', runId: 'r', page: { kind: 'chat', path: '/chat' },
      history: [{ id: 'u1', role: 'user', content: 'hi' }], createdAt: '2026-01-01T00:00:00.000Z',
    }, writer, nowMs);
    return { items, recorder };
  }
  const text = (delta: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta });

  it('saves partial text after THROTTLE_MS, not per token', () => {
    const { items, recorder } = recorderWith();
    recorder.observe({ type: EventType.TEXT_MESSAGE_START, messageId: 'a1' });
    recorder.observe(text('Hel'));
    clock.ms += THROTTLE_MS - 1;
    recorder.observe(text('lo'));
    expect(items).toHaveLength(0);

    clock.ms += 1;
    recorder.observe(text(' wor'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ run_status: 'running' });
    expect(messagesOf(items[0] ?? {}).at(-1)).toMatchObject({ role: 'assistant', content: 'Hello wor' });
  });

  it('saves after THROTTLE_CHARS of text even within the interval', () => {
    const { items, recorder } = recorderWith();
    recorder.observe(text('x'.repeat(THROTTLE_CHARS)));
    expect(items).toHaveLength(1);
  });

  it('saves at every tool boundary and at the end, and never after the end', () => {
    const { items, recorder } = recorderWith();
    recorder.observe({ type: EventType.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'search_feedback', parentMessageId: 'a1' });
    recorder.observe({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{}' });
    recorder.observe({ type: EventType.TOOL_CALL_END, toolCallId: 'c1' });
    recorder.observe({ type: EventType.TOOL_CALL_RESULT, messageId: 'm2', toolCallId: 'c1', content: 'r' });
    recorder.observe({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'success' } });
    recorder.observe(text('late'));
    expect(items.map((i) => i.run_status)).toStrictEqual(['running', 'running', 'finished']);
  });

  it('keeps sources on the last assistant message, as the SPA stores them', () => {
    const { items, recorder } = recorderWith();
    recorder.observe({ type: EventType.TEXT_MESSAGE_START, messageId: 'a1' });
    recorder.observe({ type: EventType.CUSTOM, name: 'assistant.sources', value: { feedback: [{ feedback_id: 'f1' }], web: [] } });
    recorder.observe({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'success' } });
    expect(messagesOf(items[0] ?? {}).at(-1)).toMatchObject({ metadata: { voc: { sources: { feedback: [{ feedback_id: 'f1' }] } } } });
  });
});

/** Two writes, each awaited to completion (settled never rejects), through one writer. */
async function twoWritesThrough(put: (item: Record<string, unknown>, revision: number) => Promise<PutOutcome>): Promise<void> {
  const writer = createSessionWriter(put, () => 1);
  for (const n of [1, 2]) {
    writer.enqueue(() => ({ n }));
    await writer.settled();
  }
}

describe('the writer: ordered, coalescing, fire-and-forget', () => {
  it('keeps one write in flight, coalesces to the newest snapshot, and writes it last', async () => {
    const order: number[] = [];
    const gate: { open: () => void } = { open: () => {} };
    const firstWrite = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const started = { first: false };
    const put = async (_item: Record<string, unknown>, revision: number): Promise<PutOutcome> => {
      if (!started.first) {
        started.first = true;
        await firstWrite;
      }
      order.push(revision);
      return 'written';
    };
    const ms = { now: 100 };
    const writer = createSessionWriter(put, () => ms.now);
    const r1 = writer.enqueue(() => ({ n: 1 }));
    // The first write is now in flight, held at the gate.
    await vi.waitFor(() => expect(started.first).toBe(true));
    writer.enqueue(() => ({ n: 2 }));
    const r3 = writer.enqueue(() => ({ n: 3 }));
    gate.open();
    await writer.settled();

    expect(order).toStrictEqual([r1, r3]);
    expect(r3).toBeGreaterThan(r1);
  });

  it('stops writing once a newer revision owns the conversation', async () => {
    const seen: number[] = [];
    await twoWritesThrough(async (_item, revision) => {
      seen.push(revision);
      return 'superseded';
    });
    expect(seen).toHaveLength(1);
  });

  it('keeps writing after a failed write', async () => {
    const calls = { n: 0 };
    await twoWritesThrough(async () => {
      calls.n += 1;
      if (calls.n === 1) throw new ServiceError('throttled');
      return 'written';
    });
    expect(calls.n).toBe(2);
  });
});

describe('the stored item', () => {
  const base = {
    callerSub: 's', threadId: 't', runId: 'r', status: 'running' as const, page: { kind: 'chat' as const, path: '/chat' },
    pendingInterrupts: [], createdAt: 'c', updatedAt: 'u', revision: 1,
  };

  it('respects the ~350 KB cap by dropping the oldest turns', () => {
    const turn = (n: number): Message[] => [
      { id: `u${n}`, role: 'user', content: `q${n}` },
      { id: `a${n}`, role: 'assistant', content: 'x'.repeat(100_000) },
    ];
    const item = buildSessionItem({ ...base, messages: [1, 2, 3, 4, 5].flatMap(turn) });

    expect(item).not.toBeNull();
    expect(estimatedItemBytes(item ?? {})).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    expect(messagesOf(item ?? {}).at(-1)).toMatchObject({ id: 'a5' });
    expect(messagesOf(item ?? {}).at(0)?.role).toBe('user');
  });

  it('never stores attachment data', () => {
    const user: Message = {
      id: 'u1', role: 'user',
      content: [{ type: 'image', source: { type: 'data', value: 'AAAA'.repeat(1000), mimeType: 'image/png' }, metadata: { name: 'shot.png' } }],
    };
    const item = buildSessionItem({ ...base, messages: [user] });
    expect(String(item?.messages_json)).not.toContain('AAAA');
    expect(String(item?.messages_json)).toContain('shot.png');
  });

  it('keeps the stored copy of earlier messages (with their metadata) over the wire copy', () => {
    const stored: Message[] = [{ id: 'a0', role: 'assistant', content: 'old', metadata: { voc: { sources: { feedback: [], web: [] } } } }];
    const wire: Message[] = [{ id: 'a0', role: 'assistant', content: 'old' }, { id: 'u1', role: 'user', content: 'new' }];
    expect(mergeHistory(wire, stored)).toStrictEqual([stored[0], wire[1]]);
  });
});
