/**
 * No session write inside a workspace that is not active (`createWorkspaceStatusCheck`, store.ts, since 7.25.00): neither the
 * owner row (`WS#{ws}#CONVERSANTS`) nor the conversation (`CONV#`) is written once the workspace is `deleting`, or
 * has no `META`, so the hard delete's sweep never misses a row written after its mark.
 */
import { describe, expect, it } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { runAssistant } from '../runtime/run.js';
import { parseLambdaEvent } from '../runtime/event.js';
import { lambdaEvent, recordingEmitter, runBody } from '../runtime/__fixtures__/fakes.js';
import { harness, silenceConsole, types } from '../runtime/__fixtures__/harness.js';
import { sessionKey } from './record.js';
import { createDynamoSessionStore } from './store.js';
import { createSessionWriter } from './writer.js';
import { WORKSPACE_NOT_FOUND, WorkspaceNotFoundError, type SessionOwner, type WorkspaceMembership } from './workspace-member.js';
import {
  ACTIVE_TTL_MS, NOT_ACTIVE_TTL_MS, STATUS_READ_ATTRIBUTES, createWorkspaceStatusCheck, readWorkspaceStatus,
} from './workspace-status.js';

silenceConsole();

const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8';
const OWNER: SessionOwner = { sub: 'sub-fern', workspace: WS };

/** voc-workspaces as the check reads it: `META`'s status (undefined: no `META` row), or a fault. */
function workspaces(initial: string | undefined) {
  const state: { status: string | undefined; fault: Error | null; reads: number } = { status: initial, fault: null, reads: 0 };
  const client = {
    send(command: GetCommand) {
      state.reads += 1;
      expect(command.input).toMatchObject({ TableName: 'workspaces', Key: { pk: `WS#${WS}`, sk: 'META' }, ConsistentRead: true });
      // Projected to the status alone: the role's GetItem is held to named attributes and refuses a read naming none.
      expect(Object.values(command.input.ExpressionAttributeNames ?? {})).toStrictEqual([...STATUS_READ_ATTRIBUTES]);
      expect(command.input.ProjectionExpression).toBe(Object.keys(command.input.ExpressionAttributeNames ?? {}).join(', '));
      if (state.fault !== null) return Promise.reject(state.fault);
      return Promise.resolve(state.status === undefined ? {} : { Item: { pk: `WS#${WS}`, sk: 'META', status: state.status } });
    },
  };
  return { client, state };
}

/** voc-conversations: every command sent, so a test sees that nothing was. */
function conversations() {
  const sent: Record<string, unknown>[] = [];
  const client = { send(command: GetCommand | PutCommand) { sent.push({ ...command.input }); return Promise.resolve({}); } };
  return { client, sent };
}

const item = () => ({ ...sessionKey(OWNER, 'thread-1'), conversation_id: 'thread-1' });

describe('the workspace status read', () => {
  it.each([['active', 'active'], ['deleting', 'deleting'], ['no META row', undefined]])(
    'reads %s fresh every time, strongly consistent and projected', async (_name, status) => {
      const { client, state } = workspaces(status);
      await expect(readWorkspaceStatus(client, 'workspaces', WS)).resolves.toBe(status);
      await expect(readWorkspaceStatus(client, 'workspaces', WS)).resolves.toBe(status);
      expect(state.reads).toBe(2);
    },
  );
});

describe('the workspace status check', () => {
  it.each([['deleting', 'deleting'], ['no META row', undefined], ['an unknown status', 'archived']])(
    'says %s is not active', async (_name, status) => {
      const check = createWorkspaceStatusCheck(workspaces(status).client, 'workspaces');
      await expect(check.isActive(WS)).resolves.toBe(false);
    },
  );

  it('pins its TTLs (300 s / 30 s)', () => {
    expect([ACTIVE_TTL_MS, NOT_ACTIVE_TTL_MS]).toStrictEqual([300_000, 30_000]);
  });

  /** The check's answers: at 0 ms with `initial`, then at each step's time (ms) with the status set to its value.
   *  Each read takes `readMs` of the fake clock, so a TTL measured from the answer, not the ask, would show. */
  async function answers(initial: string, steps: readonly (readonly [number, string])[], readMs = 1000) {
    const clock = { now: 0 };
    const { client, state } = workspaces(initial);
    const slow = { send: (command: GetCommand) => { clock.now += readMs; return client.send(command); } };
    const check = createWorkspaceStatusCheck(slow, 'workspaces', () => clock.now);
    const seen: boolean[] = [];
    for (const [now, status] of [[0, initial] as const, ...steps]) {
      clock.now = now;
      state.status = status;
      seen.push(await check.isActive(WS));
    }
    return { seen, reads: state.reads };
  }

  it('keeps an active answer 300 s from when its read was sent, then reads again', async () => {
    await expect(answers('active', [[ACTIVE_TTL_MS - 1, 'deleting'], [ACTIVE_TTL_MS, 'deleting']]))
      .resolves.toStrictEqual({ seen: [true, true, false], reads: 2 });
  });

  it('keeps a not-active answer 30 s from when its read was sent, then reads again', async () => {
    await expect(answers('deleting', [[NOT_ACTIVE_TTL_MS - 1, 'active'], [NOT_ACTIVE_TTL_MS, 'active']]))
      .resolves.toStrictEqual({ seen: [false, false, true], reads: 2 });
  });

  it('never lets an older read that returns last replace a newer answer', async () => {
    const clock = { now: 0 };
    const pending: ((status: string) => void)[] = [];
    const client = { send: () => new Promise<unknown>((resolve) => {
      pending.push((status) => { resolve({ Item: { status } }); });
    }) };
    const check = createWorkspaceStatusCheck(client, 'workspaces', () => clock.now);
    const older = check.isActive(WS);
    clock.now = 10;
    const newer = check.isActive(WS);
    pending[1]?.('deleting');
    await expect(newer).resolves.toBe(false);
    pending[0]?.('active');
    await expect(older).resolves.toBe(true);
    clock.now = 20;
    await expect(check.isActive(WS)).resolves.toBe(false);
    expect(pending).toHaveLength(2);
  });

  it('fails closed on a failed read and never keeps it: the next ask reads again', async () => {
    const { client, state } = workspaces('active');
    state.fault = new Error('ProvisionedThroughputExceededException');
    const check = createWorkspaceStatusCheck(client, 'workspaces', () => 0);
    await expect(check.isActive(WS)).rejects.toThrow('ProvisionedThroughputExceeded');
    state.fault = null;
    await expect(check.isActive(WS)).resolves.toBe(true);
    expect(state.reads).toBe(2);
  });
});

describe('the store inside a workspace that is not active', () => {
  it.each([['deleting', 'deleting'], ['no META row', undefined]])(
    'writes neither the owner row nor the conversation when it is %s', async (_name, status) => {
      const { client, sent } = conversations();
      const store = createDynamoSessionStore(client, 'conversations', undefined,
        createWorkspaceStatusCheck(workspaces(status).client, 'workspaces'));
      const refused = store.put(OWNER, item(), 1);
      await expect(refused).rejects.toBeInstanceOf(WorkspaceNotFoundError);
      await expect(refused).rejects.toMatchObject({ message: WORKSPACE_NOT_FOUND, statusCode: 404 });
      expect(sent).toStrictEqual([]);
    },
  );

  it('writes nothing while the status cannot be read', async () => {
    const { client, sent } = conversations();
    const failing = workspaces('active');
    failing.state.fault = new Error('AccessDeniedException');
    const store = createDynamoSessionStore(client, 'conversations', undefined,
      createWorkspaceStatusCheck(failing.client, 'workspaces'));
    await expect(store.put(OWNER, item(), 1)).rejects.toThrow('AccessDenied');
    expect(sent).toStrictEqual([]);
  });

  it('writes nothing inside a workspace when it was made without the check', async () => {
    const { client, sent } = conversations();
    const store = createDynamoSessionStore(client, 'conversations');
    await expect(store.put(OWNER, item(), 1)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(sent).toStrictEqual([]);
  });

  it('lists the owner, then writes the conversation, while it is active; reads no status outside a workspace', async () => {
    const { client, sent } = conversations();
    const { client: workspacesClient, state } = workspaces('active');
    const store = createDynamoSessionStore(client, 'conversations', undefined,
      createWorkspaceStatusCheck(workspacesClient, 'workspaces'));
    await expect(store.put(OWNER, item(), 1)).resolves.toBe('written');
    expect(sent.map((input) => Reflect.get(Object(input.Item), 'pk'))).toStrictEqual([`WS#${WS}#CONVERSANTS`, `WS#${WS}#USER#sub-fern`]);
    await expect(store.put({ sub: 'sub-fern' }, { pk: 'USER#sub-fern', sk: 'CONV#thread-1' }, 1)).resolves.toBe('written');
    expect(state.reads).toBe(1);
  });
});

describe('the writer after a refusal', () => {
  it('sends no later snapshot once the workspace is not active', async () => {
    const puts: number[] = [];
    const writer = createSessionWriter((_item, revision) => {
      puts.push(revision);
      return Promise.reject(new WorkspaceNotFoundError());
    }, () => 1);
    writer.enqueue(() => ({ pk: 'a' }));
    await writer.settled();
    writer.enqueue(() => ({ pk: 'a' }));
    await writer.settled();
    expect(puts).toHaveLength(1);
  });
});

describe('a run whose workspace is marked deleting after it started', () => {
  it('answers, and saves no owner row and no conversation', async () => {
    const { client, sent } = conversations();
    // The member check at the run's start saw an active workspace; the delete marks it before the first write.
    const membership: WorkspaceMembership = { isMember: () => Promise.resolve(true) };
    const marked = workspaces('deleting');
    const real = createDynamoSessionStore(client, 'conversations', undefined,
      createWorkspaceStatusCheck(marked.client, 'workspaces'));
    const attempts = { puts: 0 };
    const store = { ...real, put: (...args: Parameters<typeof real.put>) => { attempts.puts += 1; return real.put(...args); } };
    const { emitter, events } = recordingEmitter();
    const event = lambdaEvent(runBody());
    event.headers = { ...(event.headers as Record<string, string>), 'X-Workspace-Id': WS };
    const deps = { ...harness([{ text: 'Mostly happy.' }]).deps, sessions: { store, nowMs: () => 0, membership } };
    const { persisted } = await runAssistant(parseLambdaEvent(event), emitter, deps);
    await persisted;
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
    // The run tried to save once (the status was asked), was refused, and stopped saving; it sent no put, only the
    // session load's GetItem.
    expect([attempts.puts, marked.state.reads]).toStrictEqual([1, 1]);
    expect(sent.filter((input) => 'Item' in input)).toStrictEqual([]);
  });
});
