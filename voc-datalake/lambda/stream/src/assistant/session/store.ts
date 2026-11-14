/**
 * The conversations table as the stream Lambda uses it: one GetItem at run
 * start (created_at + the stored messages, to keep their metadata),
 * conditional PutItems while the run streams, and GetItems of the run's Stop
 * marker (session/cancel.ts); inside a workspace, before its first session write, one
 * PutItem if absent of the owner's row in the workspace's list of conversation owners
 * (`WS#{ws}#CONVERSANTS` / `{sub}`, record.ts `conversantKey`). IAM grants exactly GetItem +
 * PutItem on `USER#*` and `WS#{one id}#USER#*` partitions and PutItem alone on `WS#{one id}#CONVERSANTS`
 * (api-assistant-lambdas.ts, `dynamodb:LeadingKeys`): it pins the partition's shape, not whose it is. The
 * caller's own sub cannot be expressed in IAM for a Cognito sub, so that is enforced HERE: every key is
 * built by `sessionKey(owner, …)` from the verified authorizer claims (and the workspace
 * they were verified a member of, workspace-member.ts), and
 * a put whose item names another partition is refused before it is sent.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { MessageSchema } from '@ag-ui/core/schemas';
import type { Message } from '@ag-ui/core';
import { z } from 'zod';
import { callerPartition, cancelKey, conversantKey, sessionKey } from './record.js';
import type { PutOutcome } from './writer.js';
import type { SessionOwner } from './workspace-member.js';

export interface StoredSession {
  createdAt: string | null;
  messages: Message[];
  /** The user's rename (`custom_title`, chat_handler's PUT .../title); kept as the title. */
  customTitle?: string;
}

export interface SessionStore {
  load(owner: SessionOwner, threadId: string): Promise<StoredSession | null>;
  /** Conditional put scoped to `owner`'s partition; refused when the stored revision is not older. */
  put(owner: SessionOwner, item: Record<string, unknown>, revision: number): Promise<PutOutcome>;
  /** The user pressed Stop on this run: chat_handler's cancel marker names `runId`. */
  cancelRequested(owner: SessionOwner, threadId: string, runId: string): Promise<boolean>;
}

/** What the store needs of a document client. */
export interface SessionDocClient {
  send(command: GetCommand | PutCommand): Promise<unknown>;
}

const cancelItemSchema = z.object({ Item: z.object({ run_id: z.unknown().optional() }).loose().optional() }).loose();

const storedItemSchema = z.object({
  Item: z.object({
    created_at: z.unknown().optional(),
    messages_json: z.unknown().optional(),
    custom_title: z.unknown().optional(),
  }).loose().optional(),
}).loose();

function decodeMessages(raw: unknown): Message[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      const message = MessageSchema.safeParse(entry);
      return message.success ? [message.data] : [];
    });
  } catch {
    return [];
  }
}

/** How many owners a warm container remembers as listed before it forgets them all (and lists each once more). */
const MAX_LISTED_OWNERS = 1000;

export function createDynamoSessionStore(
  client: SessionDocClient, tableName: string, nowIso: () => string = () => new Date().toISOString(),
): SessionStore {
  // The owners this container has seen listed, so a run's many writes list their owner once, not once per write.
  const listed = new Set<string>();

  /**
   * Inside a workspace, list the owner among its conversation owners (record.ts `conversantKey`) if absent: a put
   * conditioned on the row being absent, so it is never duplicated and keeps its first `first_at`. Any fault but
   * "already listed" throws, so the session write after it is not sent and the conversation is never stored
   * unlisted (the writer logs it; the next write lists again).
   */
  async function listOwner(owner: SessionOwner): Promise<void> {
    const key = conversantKey(owner);
    if (key === null || listed.has(`${key.pk}\u0000${key.sk}`)) return;
    try {
      await client.send(new PutCommand({
        TableName: tableName,
        Item: { ...key, first_at: nowIso() },
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk' },
      }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
    if (listed.size >= MAX_LISTED_OWNERS) listed.clear();
    listed.add(`${key.pk}\u0000${key.sk}`);
  }

  return {
    async load(owner, threadId) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: sessionKey(owner, threadId),
        ProjectionExpression: '#created, #messages, #ct',
        ExpressionAttributeNames: { '#created': 'created_at', '#messages': 'messages_json', '#ct': 'custom_title' },
      }));
      const parsed = storedItemSchema.safeParse(response);
      const item = parsed.success ? parsed.data.Item : undefined;
      if (item === undefined) return null;
      const customTitle = typeof item.custom_title === 'string' && item.custom_title !== '' ? item.custom_title : undefined;
      return {
        createdAt: typeof item.created_at === 'string' && item.created_at !== '' ? item.created_at : null,
        messages: decodeMessages(item.messages_json),
        ...(customTitle === undefined ? {} : { customTitle }),
      };
    },
    async cancelRequested(owner, threadId, runId) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: cancelKey(owner, threadId),
        ProjectionExpression: '#run',
        ExpressionAttributeNames: { '#run': 'run_id' },
      }));
      const parsed = cancelItemSchema.safeParse(response);
      return parsed.success && parsed.data.Item?.run_id === runId;
    },
    async put(owner, item, revision) {
      if (item.pk !== callerPartition(owner)) throw new RangeError('Session item outside the caller partition');
      await listOwner(owner);
      try {
        await client.send(new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#rev) OR #rev < :rev',
          ExpressionAttributeNames: { '#rev': 'revision' },
          ExpressionAttributeValues: { ':rev': revision },
        }));
        return 'written';
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return 'superseded';
        throw error;
      }
    },
  };
}
