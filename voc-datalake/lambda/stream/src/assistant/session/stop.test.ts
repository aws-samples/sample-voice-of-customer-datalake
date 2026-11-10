/**
 * Stop cancels the server run (5.35, E2E 5.34: Stop cleared the screen, the run went on spending
 * Bedrock and a reload showed the full answer). The SPA's Stop writes a marker
 * (`POST /chat/conversations/{id}/cancel`); the run polls it (cancel.ts), aborts the Bedrock
 * stream, starts no further turn, and saves the partial answer as `stopped`, marked.
 */
import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import type { Message } from '@ag-ui/core';
import type { ConverseStreamParams } from '../../bedrock/converse-stream.js';
import { runAssistant, type RuntimeDeps } from '../runtime/run.js';
import { parseLambdaEvent } from '../runtime/event.js';
import { lambdaEvent, recordingEmitter, runBody } from '../runtime/__fixtures__/fakes.js';
import { harness, silenceConsole, types } from '../runtime/__fixtures__/harness.js';
import { createCancelWatch } from './cancel.js';
import { createDynamoSessionStore, type SessionStore } from './store.js';

silenceConsole();

interface Put { item: Record<string, unknown> }

/** A store whose Stop marker appears once `stopNow()` is called. */
function stoppableStore(): SessionStore & { puts: Put[]; stopNow: () => void; checks: string[][] } {
  const state = { stopped: false };
  const puts: Put[] = [];
  const checks: string[][] = [];
  return {
    puts,
    checks,
    stopNow: () => { state.stopped = true; },
    load: () => Promise.resolve(null),
    put: (_sub, item) => {
      puts.push({ item });
      return Promise.resolve('written');
    },
    cancelRequested: (callerSub, threadId, runId) => {
      checks.push([callerSub, threadId, runId]);
      return Promise.resolve(state.stopped);
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error('Request aborted'), { name: 'AbortError' });
}

/** One Bedrock turn that streams "Partial answer" and then hangs until it is aborted, like the SDK does. */
function hangingTurn(onStreaming: () => void) {
  return async function* converse(params: ConverseStreamParams): AsyncGenerator<ConverseStreamOutput> {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Partial answer' } } };
    onStreaming();
    await new Promise<never>((_resolve, reject) => {
      if (params.abortSignal?.aborted) reject(abortError());
      params.abortSignal?.addEventListener('abort', () => reject(abortError()));
    });
  };
}

function messagesOf(item: Record<string, unknown>): Message[] {
  const parsed: unknown = JSON.parse(String(item.messages_json));
  return Array.isArray(parsed) ? parsed.filter((m): m is Message => typeof m === 'object' && m !== null && 'role' in m) : [];
}

async function runStopped() {
  const store = stoppableStore();
  const h = harness([]);
  const converse = vi.fn(hangingTurn(() => store.stopNow()));
  const deps: RuntimeDeps = { ...h.deps, converse, sessions: { store, nowMs: () => 1_800_000_000_000, stopPollMs: 5 } };
  const { emitter, events } = recordingEmitter();
  const { persisted } = await runAssistant(parseLambdaEvent(lambdaEvent(runBody())), emitter, deps);
  await persisted;
  return { store, events, converse };
}

describe('Stop on a running answer', () => {
  it('ends the run as stopped instead of letting it finish', async () => {
    const { events, converse } = await runStopped();
    expect(types(events).slice(-4)).toStrictEqual([
      'CUSTOM:assistant.stopped', 'CUSTOM:assistant.sources', 'CUSTOM:assistant.session', 'RUN_FINISHED',
    ]);
    expect(types(events)).not.toContain('RUN_ERROR');
    // No second model turn after the stop.
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it('saves the partial answer as stopped, marked on the message', async () => {
    const { store } = await runStopped();
    const final = store.puts.at(-1)?.item ?? {};
    expect(final.run_status).toBe('stopped');
    expect(messagesOf(final).at(-1)).toMatchObject({
      role: 'assistant', content: 'Partial answer', metadata: { voc: { stopped: true } },
    });
  });

  it('polls the marker of exactly this caller, thread and run', async () => {
    const { store } = await runStopped();
    expect(store.checks.at(0)).toStrictEqual(['user-sub-1', 'thread-1', 'run-1']);
  });
});

describe('the Stop marker read', () => {
  it('reads RUNCANCEL#<thread> in the caller partition and matches the run id', async () => {
    const send = vi.fn((command: unknown) => Promise.resolve(command instanceof GetCommand ? { Item: { run_id: 'run-1' } } : {}));
    const store = createDynamoSessionStore({ send }, 'conversations');
    await expect(store.cancelRequested('sub-1', 'thread-1', 'run-1')).resolves.toBe(true);
    await expect(store.cancelRequested('sub-1', 'thread-1', 'run-2')).resolves.toBe(false);
    const command = send.mock.calls.at(0)?.[0];
    expect(command instanceof GetCommand ? command.input.Key : null).toStrictEqual({ pk: 'USER#sub-1', sk: 'RUNCANCEL#thread-1' });
  });

  it('answers no stop when there is no marker', async () => {
    const store = createDynamoSessionStore({ send: () => Promise.resolve({}) }, 'conversations');
    await expect(store.cancelRequested('sub-1', 'thread-1', 'run-1')).resolves.toBe(false);
  });
});

describe('createCancelWatch', () => {
  it('keeps polling through a failed read and aborts once stopped', async () => {
    const check = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const watch = createCancelWatch(check, 2);
    await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
    watch.stop();
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops polling when the run ends', async () => {
    const check = vi.fn(() => Promise.resolve(false));
    const watch = createCancelWatch(check, 2);
    watch.stop();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(check).not.toHaveBeenCalled();
    expect(watch.signal.aborted).toBe(false);
  });
});
