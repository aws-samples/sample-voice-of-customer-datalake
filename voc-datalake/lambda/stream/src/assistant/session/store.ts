/**
 * The conversations table as the stream Lambda uses it: one GetItem at run
 * start (created_at + the stored messages, to keep their metadata),
 * conditional PutItems while the run streams, and GetItems of the run's Stop
 * marker (session/cancel.ts). IAM grants exactly GetItem +
 * PutItem on the table (api-assistant-lambdas.ts); the per-caller partition cannot be
 * expressed in IAM for a Cognito sub, so it is enforced HERE: every key is
 * built by `sessionKey(callerSub, …)` from the verified authorizer claims, and
 * a put whose item names another partition is refused before it is sent.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { MessageSchema } from '@ag-ui/core/schemas';
import type { Message } from '@ag-ui/core';
import { z } from 'zod';
import { callerPartition, cancelKey, sessionKey } from './record.js';
import type { PutOutcome } from './writer.js';

export interface StoredSession {
  createdAt: string | null;
  messages: Message[];
  /** The user's rename (`custom_title`, chat_handler's PUT .../title); kept as the title. */
  customTitle?: string;
}

export interface SessionStore {
  load(callerSub: string, threadId: string): Promise<StoredSession | null>;
  /** Conditional put scoped to `callerSub`'s partition; refused when the stored revision is not older. */
  put(callerSub: string, item: Record<string, unknown>, revision: number): Promise<PutOutcome>;
  /** The user pressed Stop on this run: chat_handler's cancel marker names `runId`. */
  cancelRequested(callerSub: string, threadId: string, runId: string): Promise<boolean>;
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

export function createDynamoSessionStore(client: SessionDocClient, tableName: string): SessionStore {
  return {
    async load(callerSub, threadId) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: sessionKey(callerSub, threadId),
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
    async cancelRequested(callerSub, threadId, runId) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: cancelKey(callerSub, threadId),
        ProjectionExpression: '#run',
        ExpressionAttributeNames: { '#run': 'run_id' },
      }));
      const parsed = cancelItemSchema.safeParse(response);
      return parsed.success && parsed.data.Item?.run_id === runId;
    },
    async put(callerSub, item, revision) {
      if (item.pk !== callerPartition(callerSub)) throw new RangeError('Session item outside the caller partition');
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
