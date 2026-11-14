/**
 * The voc-conversations keys the stream Lambda builds (record.ts) agree with the chat routes' (lambda/shared/
 * conversations.py, LOCKSTEP): both read voc-datalake/schemas/conversation-keys-cases.json (the Python side:
 * lambda/api/test/test_conversation_keys_lockstep.py). And inside a workspace the store lists the owner among the
 * workspace's conversation owners, if absent, before the conversation is written.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { cancelKey, conversantKey, sessionKey } from './record.js';
import { createDynamoSessionStore } from './store.js';
import type { SessionOwner } from './workspace-member.js';
import type { WorkspaceStatusCheck } from './workspace-status.js';

const KeySchema = z.object({ pk: z.string(), sk: z.string() });
const CasesSchema = z.object({
  cases: z.array(z.object({
    sub: z.string(),
    workspace: z.string().nullable(),
    conversation_id: z.string(),
    conversation: KeySchema,
    cancel: KeySchema,
    conversant: KeySchema.nullable(),
  })),
});
// lambda/stream/src/assistant/session -> voc-datalake/schemas; built from static parts only, so a fixed repo file.
const casesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../schemas/conversation-keys-cases.json');
const { cases } = CasesSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')));

const ownerOf = (sub: string, workspace: string | null): SessionOwner => (workspace === null ? { sub } : { sub, workspace });

describe('the keys agree with the chat routes', () => {
  it.each(cases)('$workspace / $sub', ({ sub, workspace, conversation_id: threadId, conversation, cancel, conversant }) => {
    const owner = ownerOf(sub, workspace);
    expect(sessionKey(owner, threadId)).toStrictEqual(conversation);
    expect(cancelKey(owner, threadId)).toStrictEqual(cancel);
    expect(conversantKey(owner)).toStrictEqual(conversant);
  });

  it('cover both scopes', () => {
    expect(new Set(cases.map((c) => c.workspace === null))).toStrictEqual(new Set([true, false]));
  });
});

const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8';
const MEMBER: SessionOwner = { sub: 'sub-fern', workspace: WS };
const FIRST_AT = '2026-11-13T09:00:00.000Z';
/** A workspace that stays active (the status check's own spec covers one that is not). */
const ACTIVE: WorkspaceStatusCheck = { isActive: () => Promise.resolve(true) };

/** A document client that records each command's input and answers the conversant put with `conversant`. */
function recordingClient(conversant: () => Promise<unknown> = () => Promise.resolve({})) {
  const sent: Record<string, unknown>[] = [];
  const client = { send: vi.fn((command: GetCommand | PutCommand) => {
    const input: Record<string, unknown> = { ...command.input };
    sent.push(input);
    const item: unknown = input.Item;
    const isConversant = typeof item === 'object' && item !== null && Reflect.get(item, 'pk') === `WS#${WS}#CONVERSANTS`;
    return isConversant ? conversant() : Promise.resolve({});
  }) };
  return { client, sent };
}

const sessionItem = (owner: SessionOwner) => ({ ...sessionKey(owner, 'thread-1'), conversation_id: 'thread-1' });

describe('the store lists the owner of a workspace conversation', () => {
  it('puts the owner row if absent, before the first conversation write, once per owner', async () => {
    const { client, sent } = recordingClient();
    const store = createDynamoSessionStore(client, 'conv-table', () => FIRST_AT, ACTIVE);

    await store.put(MEMBER, sessionItem(MEMBER), 1);
    await store.put(MEMBER, sessionItem(MEMBER), 2);

    expect(sent).toStrictEqual([
      {
        TableName: 'conv-table',
        Item: { pk: `WS#${WS}#CONVERSANTS`, sk: 'sub-fern', first_at: FIRST_AT },
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk' },
      },
      expect.objectContaining({ Item: sessionItem(MEMBER), ExpressionAttributeValues: { ':rev': 1 } }),
      expect.objectContaining({ Item: sessionItem(MEMBER), ExpressionAttributeValues: { ':rev': 2 } }),
    ]);
  });

  it('takes an owner already listed as listed, and writes the conversation', async () => {
    const listed = new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
    const { client, sent } = recordingClient(() => Promise.reject(listed));
    const store = createDynamoSessionStore(client, 'conv-table', () => FIRST_AT, ACTIVE);

    await expect(store.put(MEMBER, sessionItem(MEMBER), 1)).resolves.toBe('written');
    await store.put(MEMBER, sessionItem(MEMBER), 2);

    expect(sent.map((input) => Reflect.get(Object(input.Item), 'pk'))).toStrictEqual([
      `WS#${WS}#CONVERSANTS`, `WS#${WS}#USER#sub-fern`, `WS#${WS}#USER#sub-fern`,
    ]);
  });

  it('does not write the conversation while its owner cannot be listed, and lists them at the next write', async () => {
    const calls = { conversant: 0 };
    const { client, sent } = recordingClient(() => {
      calls.conversant += 1;
      return calls.conversant === 1 ? Promise.reject(new Error('ProvisionedThroughputExceededException')) : Promise.resolve({});
    });
    const store = createDynamoSessionStore(client, 'conv-table', () => FIRST_AT, ACTIVE);

    await expect(store.put(MEMBER, sessionItem(MEMBER), 1)).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(sent).toHaveLength(1);

    await expect(store.put(MEMBER, sessionItem(MEMBER), 2)).resolves.toBe('written');
    expect(sent.map((input) => Reflect.get(Object(input.Item), 'pk'))).toStrictEqual([
      `WS#${WS}#CONVERSANTS`, `WS#${WS}#CONVERSANTS`, `WS#${WS}#USER#sub-fern`,
    ]);
  });

  it('lists each owner of each workspace on its own', async () => {
    const { client, sent } = recordingClient();
    const store = createDynamoSessionStore(client, 'conv-table', () => FIRST_AT, ACTIVE);
    const other: SessionOwner = { sub: 'sub-gale', workspace: WS };

    await store.put(MEMBER, sessionItem(MEMBER), 1);
    await store.put(other, sessionItem(other), 1);

    expect(sent.filter((input) => input.ConditionExpression === 'attribute_not_exists(#pk)').map((input) => input.Item))
      .toStrictEqual([
        { pk: `WS#${WS}#CONVERSANTS`, sk: 'sub-fern', first_at: FIRST_AT },
        { pk: `WS#${WS}#CONVERSANTS`, sk: 'sub-gale', first_at: FIRST_AT },
      ]);
  });

  it('lists nobody for a conversation outside any workspace', async () => {
    const { client, sent } = recordingClient();
    const store = createDynamoSessionStore(client, 'conv-table');
    const own: SessionOwner = { sub: 'sub-fern' };

    await store.put(own, sessionItem(own), 1);

    expect(sent).toStrictEqual([expect.objectContaining({ Item: sessionItem(own) })]);
  });

  it('lists nobody for an item outside the caller partition, which it refuses first', async () => {
    const { client, sent } = recordingClient();
    const store = createDynamoSessionStore(client, 'conv-table');

    await expect(store.put(MEMBER, { pk: `WS#${WS}#USER#sub-other`, sk: 'CONV#thread-1' }, 1)).rejects.toThrow(/partition/);
    expect(sent).toStrictEqual([]);
  });
});
