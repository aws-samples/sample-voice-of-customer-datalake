/**
 * A run's conversation inside a workspace (workspace-member.ts): saved in the caller's own partition there, only
 * when they are a member; LOCKSTEP with lambda/shared/workspace.py and lambda/shared/conversations.py.
 */
import { describe, it, expect } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { runAssistant } from '../runtime/run.js';
import { parseLambdaEvent } from '../runtime/event.js';
import { lambdaEvent, recordingEmitter, runBody } from '../runtime/__fixtures__/fakes.js';
import { harness, silenceConsole, types } from '../runtime/__fixtures__/harness.js';
import { callerPartition, cancelKey, sessionKey } from './record.js';
import { createDynamoSessionStore, type SessionStore } from './store.js';
import {
  WORKSPACE_NOT_FOUND, WorkspaceNotFoundError, createWorkspaceMembership, resolveSessionOwner,
  type SessionOwner, type WorkspaceMembership,
} from './workspace-member.js';

silenceConsole();

const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8';
const member = (...members: string[]): WorkspaceMembership => ({
  isMember: (ws, sub) => Promise.resolve(ws === WS && members.includes(sub)),
});

describe('the session owner', () => {
  it('is the caller alone when the request names no workspace (a blank header names none)', async () => {
    await expect(resolveSessionOwner(member(), { sub: 'sub-a' })).resolves.toStrictEqual({ sub: 'sub-a' });
    await expect(resolveSessionOwner(undefined, { sub: 'sub-a', 'voc:workspace': '  ' })).resolves.toStrictEqual({ sub: 'sub-a' });
  });

  it('is the caller inside the workspace they are a member of (the header trimmed)', async () => {
    await expect(resolveSessionOwner(member('sub-a'), { sub: 'sub-a', 'voc:workspace': ` ${WS} ` }))
      .resolves.toStrictEqual({ sub: 'sub-a', workspace: WS });
  });

  it('is no owner for an entered platform admin who is not a member: the run saves nothing', async () => {
    await expect(resolveSessionOwner(member(), { sub: 'sub-a', 'voc:workspace': WS, 'cognito:groups': '[platform-admins, users]' }))
      .resolves.toBeUndefined();
  });

  it.each([
    ['a non-member', member('sub-b'), 'sub-a', WS],
    ['a malformed id', member('sub-a'), 'sub-a', 'ws_nope'],
    ['a service subject', member('mcp:tok_1'), 'mcp:tok_1', WS],
    ['no membership table', undefined, 'sub-a', WS],
  ])('is the one 404 for %s', async (_name, membership, sub, ws) => {
    const refused = resolveSessionOwner(membership, { sub, 'voc:workspace': ws });
    await expect(refused).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(refused).rejects.toMatchObject({ message: WORKSPACE_NOT_FOUND, statusCode: 404 });
  });
});

describe('the membership read', () => {
  function table(rows: Record<string, Record<string, unknown>>) {
    return {
      client: {
        send(command: GetCommand) {
          const { pk, sk } = command.input.Key as { pk: string; sk: string };
          expect(command.input.ConsistentRead).toBe(true);
          const item = rows[`${pk}/${sk}`];
          return Promise.resolve(item === undefined ? {} : { Item: item });
        },
      },
    };
  }

  it('needs a known role and an active workspace', async () => {
    const rows = {
      [`WS#${WS}/MEMBER#sub-a`]: { role: 'viewer' }, [`WS#${WS}/MEMBER#sub-x`]: { role: 'owner' },
      [`WS#${WS}/META`]: { status: 'active' },
    };
    const { client } = table(rows);
    const membership = createWorkspaceMembership(client, 'workspaces');
    await expect(membership.isMember(WS, 'sub-a')).resolves.toBe(true);
    await expect(membership.isMember(WS, 'sub-x')).resolves.toBe(false);
    await expect(membership.isMember(WS, 'sub-none')).resolves.toBe(false);
    const deleting = createWorkspaceMembership(table({ ...rows, [`WS#${WS}/META`]: { status: 'deleting' } }).client, 'workspaces');
    await expect(deleting.isMember(WS, 'sub-a')).resolves.toBe(false);
  });

  it('reads fresh every time: a membership added or removed a moment ago counts at once', async () => {
    const rows: Record<string, Record<string, unknown>> = { [`WS#${WS}/META`]: { status: 'active' } };
    const membership = createWorkspaceMembership(table(rows).client, 'workspaces');
    await expect(membership.isMember(WS, 'sub-a')).resolves.toBe(false);
    rows[`WS#${WS}/MEMBER#sub-a`] = { role: 'editor' };
    await expect(membership.isMember(WS, 'sub-a')).resolves.toBe(true);
    Reflect.deleteProperty(rows, `WS#${WS}/MEMBER#sub-a`);
    await expect(membership.isMember(WS, 'sub-a')).resolves.toBe(false);
  });
});

describe('the keys', () => {
  const owner: SessionOwner = { sub: 'sub-a', workspace: WS };

  it("are the caller's partition inside the workspace, the same as chat_handler.py's", () => {
    expect(callerPartition({ sub: 'sub-a' })).toBe('USER#sub-a');
    expect(callerPartition(owner)).toBe(`WS#${WS}#USER#sub-a`);
    expect(sessionKey(owner, 't1')).toStrictEqual({ pk: `WS#${WS}#USER#sub-a`, sk: 'CONV#t1' });
    expect(cancelKey(owner, 't1')).toStrictEqual({ pk: `WS#${WS}#USER#sub-a`, sk: 'RUNCANCEL#t1' });
  });

  it("a put outside the owner's partition is refused before it is sent", async () => {
    const sent: unknown[] = [];
    const store = createDynamoSessionStore({ send: (command) => { sent.push(command); return Promise.resolve({}); } }, 'conversations');
    await expect(store.put(owner, { pk: 'USER#sub-a', sk: 'CONV#t1' }, 1)).rejects.toThrow(/partition/);
    await expect(store.put({ sub: 'sub-a' }, { pk: `WS#${WS}#USER#sub-a`, sk: 'CONV#t1' }, 1)).rejects.toThrow(/partition/);
    expect(sent).toHaveLength(0);
  });
});

describe('a run inside a workspace', () => {
  function recordingStore(): SessionStore & { loads: SessionOwner[]; puts: string[] } {
    const loads: SessionOwner[] = [];
    const puts: string[] = [];
    return {
      loads, puts,
      load: (owner) => { loads.push(owner); return Promise.resolve(null); },
      cancelRequested: () => Promise.resolve(false),
      put: (_owner, item) => { puts.push(String(item.pk)); return Promise.resolve('written'); },
    };
  }

  async function run(store: SessionStore, membership: WorkspaceMembership | undefined, ws: string,
    claims?: Record<string, string>) {
    const { emitter, events } = recordingEmitter();
    const event = lambdaEvent(runBody(), claims);
    event.headers = { ...(event.headers as Record<string, string>), 'X-Workspace-Id': ws };
    const deps = { ...harness([{ text: 'Mostly happy.' }]).deps, sessions: { store, nowMs: () => 0, ...(membership ? { membership } : {}) } };
    const { persisted } = await runAssistant(parseLambdaEvent(event), emitter, deps);
    await persisted;
    return events;
  }

  it("saves a member's conversation in their partition there", async () => {
    const store = recordingStore();
    await run(store, member('user-sub-1'), WS);
    expect(store.loads).toStrictEqual([{ sub: 'user-sub-1', workspace: WS }]);
    expect(new Set(store.puts)).toStrictEqual(new Set([`WS#${WS}#USER#user-sub-1`]));
  });

  it('answers an entered platform admin who is not a member, and reads or saves no session row', async () => {
    const store = recordingStore();
    const events = await run(store, member(), WS, { sub: 'user-sub-1', 'cognito:groups': '[platform-admins, users]' });
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
    expect([store.loads, store.puts]).toStrictEqual([[], []]);
  });

  it('ends with the generic run error, and no session row, when the membership cannot be read', async () => {
    const store = recordingStore();
    const failing: WorkspaceMembership = { isMember: () => Promise.reject(new Error('ProvisionedThroughputExceededException: arn:aws:dynamodb:table/workspaces')) };
    const events = await run(store, failing, WS);
    expect(types(events).at(-1)).toBe('RUN_ERROR');
    expect(JSON.stringify(events.at(-1))).not.toMatch(/dynamodb|workspaces|Throughput/);
    expect([store.loads, store.puts]).toStrictEqual([[], []]);
  });

  it('ends with the one 404 for a workspace the caller is not a member of, before any session row', async () => {
    const store = recordingStore();
    const events = await run(store, member('someone-else'), WS);
    expect(types(events).at(-1)).toBe('RUN_ERROR');
    expect(events.at(-1)).toMatchObject({ message: WORKSPACE_NOT_FOUND });
    expect([store.loads, store.puts]).toStrictEqual([[], []]);
  });
});
