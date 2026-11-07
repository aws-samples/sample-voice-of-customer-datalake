/**
 * The session notice (run-session.ts settleAndNotify, docs/realtime.md): once a run's last write has
 * landed, the caller's own `/chat/<sub>` channel hears `{type: 'session', conversation_id, run_status,
 * revision}`, for every way a run ends; a lost notice never touches the run.
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../lib/errors.js';
import type { PublishNotice } from '../../lib/realtime-publish.js';
import { runAssistant, type RuntimeDeps } from '../runtime/run.js';
import { parseLambdaEvent } from '../runtime/event.js';
import { failingStream, lambdaEvent, recordingEmitter, runBody } from '../runtime/__fixtures__/fakes.js';
import { harness, silenceConsole, types } from '../runtime/__fixtures__/harness.js';
import { settleAndNotify } from './run-session.js';
import type { SessionStore } from './store.js';

silenceConsole();

interface Notice { namespace: string; sub: string; event: Record<string, unknown> }

function recordingStore(order: string[]): SessionStore & { revisions: number[] } {
  const revisions: number[] = [];
  return {
    revisions,
    load: () => Promise.resolve(null),
    put: (_sub, _item, revision) => {
      order.push(`put:${revision}`);
      revisions.push(revision);
      return Promise.resolve('written');
    },
    cancelRequested: () => Promise.resolve(false),
  };
}

function recordingNotify(order: string[], answer = true): { notify: PublishNotice; notices: Notice[] } {
  const notices: Notice[] = [];
  const notify: PublishNotice = (namespace, sub, event) => {
    order.push('notify');
    notices.push({ namespace, sub, event });
    return Promise.resolve(answer);
  };
  return { notify, notices };
}

async function run(deps: RuntimeDeps) {
  const { emitter, events } = recordingEmitter();
  const { persisted } = await runAssistant(parseLambdaEvent(lambdaEvent(runBody())), emitter, deps);
  await persisted;
  return events;
}

const nowMs = () => 1_800_000_000_000;

describe('the session notice', () => {
  it('is sent once, to the caller\'s chat channel, after the final write, with its revision', async () => {
    const order: string[] = [];
    const store = recordingStore(order);
    const { notify, notices } = recordingNotify(order);
    await run({ ...harness([{ text: 'Mostly happy.' }]).deps, sessions: { store, nowMs, notify } });

    expect(notices).toStrictEqual([{
      namespace: 'chat', sub: 'user-sub-1',
      event: { type: 'session', conversation_id: 'thread-1', run_status: 'finished', revision: store.revisions.at(-1) },
    }]);
    expect(order.slice(-2)).toStrictEqual([`put:${String(store.revisions.at(-1))}`, 'notify']);
  });

  it('says interrupted for an approval stop and failed for a failed run', async () => {
    const order: string[] = [];
    const approval = recordingNotify(order);
    const h = harness([{ toolUses: [{ id: 'tc1', name: 'create_project', input: { name: 'Checkout' } }] }]);
    await run({ ...h.deps, sessions: { store: recordingStore(order), nowMs, notify: approval.notify } });
    expect(approval.notices.at(0)?.event.run_status).toBe('interrupted');

    const failure = recordingNotify(order);
    const failing: RuntimeDeps = {
      ...harness([]).deps, converse: () => failingStream(new ServiceError('boom')),
      sessions: { store: recordingStore(order), nowMs, notify: failure.notify },
    };
    await run(failing);
    expect(failure.notices.at(0)?.event.run_status).toBe('failed');
  });

  it('a refused notice leaves the stream complete', async () => {
    const order: string[] = [];
    const { notify } = recordingNotify(order, false);
    const events = await run({ ...harness([{ text: 'x' }]).deps, sessions: { store: recordingStore(order), nowMs, notify } });
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
  });

  it('sends nothing for a run with no terminal event, or without a publisher', async () => {
    const notify = vi.fn<PublishNotice>(() => Promise.resolve(true));
    const target = { callerSub: 'sub-1', threadId: 'thread-1' };
    await settleAndNotify(Promise.resolve(), { outcome: () => ({ status: 'running', revision: 3 }) }, notify, target);
    expect(notify).not.toHaveBeenCalled();
    await expect(settleAndNotify(Promise.resolve(), { outcome: () => ({ status: 'stopped', revision: 4 }) }, undefined, target))
      .resolves.toBeUndefined();
    await settleAndNotify(Promise.resolve(), { outcome: () => ({ status: 'stopped', revision: 4 }) }, notify, target);
    expect(notify).toHaveBeenCalledWith('chat', 'sub-1', {
      type: 'session', conversation_id: 'thread-1', run_status: 'stopped', revision: 4,
    });
  });
});
