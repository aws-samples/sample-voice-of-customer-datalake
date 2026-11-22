/**
 * Everything the relay reads and writes (docs/voice-personas.md → Data), and nothing else: its execution role allows
 * exactly these calls (lib/stacks/voice-relay.ts pins them).
 *
 * voc-projects, the session's own partition only (`VOICE#<session id>` / `SESSION`; the role's `LeadingKeys` hold it
 * there and its `Attributes` to the names below), UpdateItem alone:
 * - activate: `minted` → `live` once, before the URL's minute is up (single use: a second connection is refused);
 * - usage and parts: `seconds`, `tokens`, `cost_microusd`, `streams`, `transcript_parts`, only while the row exists
 *   (a deleted project's session row is never made again: the write fails with `SessionGoneError`);
 * - ended: `status`, `ended_at`, `end_reason`, only while `live` (the projects API may have ended it first).
 * voc-aggregates, `VOICEUSE#…` rows only, UpdateItem alone: the month's seconds and cost (`ADD`, the new totals back),
 * and leaving the deployment's live set (`VOICEUSE#LIVE`).
 * The raw bucket, under `scratch/voice/<session id>/` (expired after 2 days): GetObject of `evidence.json`, PutObject
 * of `transcript/part-NNNN.json`, write-once (`If-None-Match: *`). No delete, no list, no other key.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { signedRequest, type SignedRequest } from '../lib/sigv4.js';
import type { VoiceEndReason } from './protocol.js';
import type { TokenTotals } from './sonic-events.js';

const SESSION_SK = 'SESSION';
const USAGE_SK = 'USAGE';
const LIVE_KEY = { pk: 'VOICEUSE#LIVE', sk: 'LIVE' } as const;
const S3_TIMEOUT_MS = 10_000;

export interface SessionUsage {
  seconds: number;
  tokens: TokenTotals;
  costMicroUsd: number;
  streams: number;
}

export interface MonthTotals {
  seconds: number;
  costMicroUsd: number;
}

export interface VoiceStore {
  /** `minted` → `live`, while the URL's minute lasts; false when it was used, ended or expired. */
  activate(sessionId: string, now: Date): Promise<boolean>;
  /** The session's input (session-input.ts), as JSON. */
  loadInput(sessionId: string): Promise<unknown>;
  writePart(sessionId: string, part: number, body: string): Promise<void>;
  recordParts(sessionId: string, parts: number): Promise<void>;
  recordUsage(sessionId: string, usage: SessionUsage): Promise<void>;
  /** Add to the month's usage; the month's seconds and cost after it. */
  addMonthly(usageKey: string, seconds: number, costMicroUsd: number, now: Date): Promise<MonthTotals>;
  markEnded(sessionId: string, reason: VoiceEndReason, now: Date): Promise<void>;
  leaveLive(sessionId: string): Promise<void>;
}

/** The one failure the relay reads: an update whose condition did not hold. */
function conditionFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/** The session row is gone (its project was deleted): the session ends. */
export class SessionGoneError extends Error {
  constructor() {
    super('The voice session row is gone');
    this.name = 'SessionGoneError';
  }
}

const countOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Where the store's AWS calls go (the real clients by default; a spec passes its fakes). */
export interface StoreDeps {
  update(input: UpdateCommandInput): Promise<Record<string, unknown> | undefined>;
  request(request: SignedRequest): Promise<Response>;
}

export interface StoreConfig {
  projectsTable: string;
  aggregatesTable: string;
  bucket: string;
  region: string;
}

/** A failed S3 call, by its HTTP status only (never the body, which could quote the object). */
export class ObjectStoreError extends Error {
  constructor(operation: string, status: number) {
    super(`${operation} answered ${status}`);
    this.name = 'ObjectStoreError';
  }
}

export function awsStoreDeps(region: string): StoreDeps {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  return {
    async update(input) {
      const output = await client.send(new UpdateCommand(input));
      return output.Attributes;
    },
    request: signedRequest,
  };
}

const prefix = (sessionId: string): string => `scratch/voice/${sessionId}`;

export function createVoiceStore(config: StoreConfig, deps: StoreDeps): VoiceStore {
  const session = (sessionId: string) => ({ TableName: config.projectsTable, Key: { pk: `VOICE#${sessionId}`, sk: SESSION_SK } });
  const objectUrl = (key: string) => `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  const s3 = async (operation: string, init: Omit<SignedRequest, 'service' | 'region' | 'timeoutMs' | 'uriEscapePath'>) => {
    const response = await deps.request({ ...init, service: 's3', region: config.region, timeoutMs: S3_TIMEOUT_MS, uriEscapePath: false });
    if (!response.ok) throw new ObjectStoreError(operation, response.status);
    return response;
  };
  /** An update of the session row that never makes it again: on a row that is gone, `SessionGoneError`. */
  const existing = async (input: UpdateCommandInput): Promise<void> => {
    try {
      await deps.update({ ...input, ConditionExpression: 'attribute_exists(pk)' });
    } catch (error) {
      if (conditionFailed(error)) throw new SessionGoneError();
      throw error;
    }
  };
  return {
    async activate(sessionId, now) {
      try {
        await deps.update({
          ...session(sessionId),
          UpdateExpression: 'SET #status = :live, connected_at = :now',
          ConditionExpression: '#status = :minted AND connect_by >= :epoch',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':live': 'live', ':minted': 'minted', ':now': now.toISOString(), ':epoch': Math.floor(now.getTime() / 1000) },
        });
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },
    async loadInput(sessionId) {
      const response = await s3('GetObject', { method: 'GET', url: objectUrl(`${prefix(sessionId)}/evidence.json`) });
      const parsed: unknown = JSON.parse(await response.text());
      return parsed;
    },
    async writePart(sessionId, part, body) {
      const key = `${prefix(sessionId)}/transcript/part-${String(part).padStart(4, '0')}.json`;
      await s3('PutObject', {
        method: 'PUT', url: objectUrl(key), body, headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      });
    },
    recordParts: (sessionId, parts) => existing({
      ...session(sessionId), UpdateExpression: 'SET transcript_parts = :parts', ExpressionAttributeValues: { ':parts': parts },
    }),
    recordUsage: (sessionId, usage) => existing({
      ...session(sessionId),
      UpdateExpression: 'SET seconds = :seconds, tokens = :tokens, cost_microusd = :cost, streams = :streams',
      ExpressionAttributeValues: {
        ':seconds': usage.seconds, ':tokens': usage.tokens, ':cost': usage.costMicroUsd, ':streams': usage.streams,
      },
    }),
    async addMonthly(usageKey, seconds, costMicroUsd, now) {
      const attributes = await deps.update({
        TableName: config.aggregatesTable, Key: { pk: usageKey, sk: USAGE_SK },
        UpdateExpression: 'ADD seconds :seconds, cost_microusd :cost SET updated_at = :now',
        ExpressionAttributeValues: { ':seconds': seconds, ':cost': costMicroUsd, ':now': now.toISOString() },
        ReturnValues: 'UPDATED_NEW',
      });
      return { seconds: countOf(attributes?.seconds), costMicroUsd: countOf(attributes?.cost_microusd) };
    },
    async markEnded(sessionId, reason, now) {
      try {
        await deps.update({
          ...session(sessionId),
          UpdateExpression: 'SET #status = :ended, ended_at = if_not_exists(ended_at, :now), end_reason = if_not_exists(end_reason, :reason)',
          ConditionExpression: '#status = :live',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ended': 'ended', ':live': 'live', ':now': now.toISOString(), ':reason': reason },
        });
      } catch (error) {
        // The projects API ended it first (End, or its budget stop): its status and reason stand.
        if (!conditionFailed(error)) throw error;
      }
    },
    async leaveLive(sessionId) {
      await deps.update({
        TableName: config.aggregatesTable, Key: LIVE_KEY,
        UpdateExpression: 'REMOVE live.#session', ExpressionAttributeNames: { '#session': sessionId },
      });
    },
  };
}
