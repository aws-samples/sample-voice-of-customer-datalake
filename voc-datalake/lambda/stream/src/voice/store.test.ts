import { describe, expect, it, vi } from 'vitest';
import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import type { SignedRequest } from '../lib/sigv4.js';
import { createVoiceStore, ObjectStoreError, SessionGoneError, type StoreDeps } from './store.js';
import { SESSION_ID } from './voice-fixtures.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const CONFIG = { projectsTable: 'voc-projects', aggregatesTable: 'voc-aggregates', bucket: 'voc-raw', region: 'us-west-2' };
const SESSION_KEY = { TableName: 'voc-projects', Key: { pk: `VOICE#${SESSION_ID}`, sk: 'SESSION' } };

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function store(answer: Partial<StoreDeps> = {}) {
  const update = vi.fn<(input: UpdateCommandInput) => Promise<Record<string, unknown> | undefined>>(() => Promise.resolve(undefined));
  const request = vi.fn<(input: SignedRequest) => Promise<Response>>(() => Promise.resolve(new Response('{"version":1}')));
  return { update, request, store: createVoiceStore(CONFIG, { update: answer.update ?? update, request: answer.request ?? request }) };
}

describe('voice store: the session row', () => {
  it('activates a minted session once, within its minute, in its own partition', async () => {
    const run = store();
    await expect(run.store.activate(SESSION_ID, NOW)).resolves.toBe(true);
    expect(run.update).toHaveBeenCalledWith({
      ...SESSION_KEY,
      UpdateExpression: 'SET #status = :live, connected_at = :now',
      ConditionExpression: '#status = :minted AND connect_by >= :epoch',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':live': 'live', ':minted': 'minted', ':now': '2026-11-21T12:00:00.000Z', ':epoch': 1_795_262_400 },
    });
  });

  it('answers false for a used, ended or expired session, and lets any other failure through', async () => {
    const used = store({ update: () => Promise.reject(named('ConditionalCheckFailedException')) });
    const failing = store({ update: () => Promise.reject(named('AccessDeniedException')) });
    await expect(used.store.activate(SESSION_ID, NOW)).resolves.toBe(false);
    await expect(failing.store.activate(SESSION_ID, NOW)).rejects.toThrow('AccessDeniedException');
  });

  it('records usage and parts with SET only, only on a row that exists', async () => {
    const run = store();
    await run.store.recordUsage(SESSION_ID, { seconds: 61, tokens: { speech_in: 1, speech_out: 2, text_in: 3, text_out: 4 }, costMicroUsd: 99, streams: 2 });
    await run.store.recordParts(SESSION_ID, 3);
    expect(run.update.mock.calls.map(([input]) => input.UpdateExpression)).toStrictEqual([
      'SET seconds = :seconds, tokens = :tokens, cost_microusd = :cost, streams = :streams', 'SET transcript_parts = :parts',
    ]);
    expect(run.update.mock.calls.map(([input]) => [input.Key, input.ConditionExpression])).toStrictEqual([
      [SESSION_KEY.Key, 'attribute_exists(pk)'], [SESSION_KEY.Key, 'attribute_exists(pk)']]);
  });

  it('says the row is gone when its condition fails (a deleted project), and lets any other failure through', async () => {
    const gone = store({ update: () => Promise.reject(named('ConditionalCheckFailedException')) });
    const failing = store({ update: () => Promise.reject(named('ProvisionedThroughputExceededException')) });
    await expect(gone.store.recordParts(SESSION_ID, 1)).rejects.toThrow(new SessionGoneError());
    await expect(failing.store.recordUsage(SESSION_ID, { seconds: 1, tokens: { speech_in: 0, speech_out: 0, text_in: 0, text_out: 0 }, costMicroUsd: 0, streams: 1 }))
      .rejects.toThrow('ProvisionedThroughputExceededException');
  });

  it('marks it ended only while live, keeping a reason the API wrote first', async () => {
    const run = store();
    await run.store.markEnded(SESSION_ID, 'budget', NOW);
    const ended = store({ update: () => Promise.reject(named('ConditionalCheckFailedException')) });
    await expect(ended.store.markEnded(SESSION_ID, 'budget', NOW)).resolves.toBeUndefined();
    expect(run.update).toHaveBeenCalledWith(expect.objectContaining({
      UpdateExpression: 'SET #status = :ended, ended_at = if_not_exists(ended_at, :now), end_reason = if_not_exists(end_reason, :reason)',
      ConditionExpression: '#status = :live',
    }));
  });
});

describe('voice store: the month and the live set', () => {
  it('adds the month\'s seconds and cost and answers its new totals', async () => {
    const run = store();
    run.update.mockResolvedValueOnce({ seconds: 4200, cost_microusd: 10 });
    await expect(run.store.addMonthly('VOICEUSE#DEPLOYMENT#2026-11', 60, 900, NOW)).resolves.toStrictEqual({ seconds: 4200, costMicroUsd: 10 });
    expect(run.update).toHaveBeenCalledWith({
      TableName: 'voc-aggregates', Key: { pk: 'VOICEUSE#DEPLOYMENT#2026-11', sk: 'USAGE' },
      UpdateExpression: 'ADD seconds :seconds, cost_microusd :cost SET updated_at = :now',
      ExpressionAttributeValues: { ':seconds': 60, ':cost': 900, ':now': '2026-11-21T12:00:00.000Z' }, ReturnValues: 'UPDATED_NEW',
    });
    await expect(run.store.addMonthly('VOICEUSE#DEPLOYMENT#2026-11', 0, 0, NOW)).resolves.toStrictEqual({ seconds: 0, costMicroUsd: 0 });
  });

  it('leaves the deployment\'s live set', async () => {
    const run = store();
    await run.store.leaveLive(SESSION_ID);
    expect(run.update).toHaveBeenCalledWith({
      TableName: 'voc-aggregates', Key: { pk: 'VOICEUSE#LIVE', sk: 'LIVE' },
      UpdateExpression: 'REMOVE live.#session', ExpressionAttributeNames: { '#session': SESSION_ID },
    });
  });
});

describe('voice store: the scratch objects', () => {
  it('reads the session\'s evidence.json, signed for S3 with the path as sent', async () => {
    const run = store();
    await expect(run.store.loadInput(SESSION_ID)).resolves.toStrictEqual({ version: 1 });
    expect(run.request).toHaveBeenCalledWith({
      method: 'GET', url: `https://voc-raw.s3.us-west-2.amazonaws.com/scratch/voice/${SESSION_ID}/evidence.json`,
      service: 's3', region: 'us-west-2', timeoutMs: 10_000, uriEscapePath: false,
    });
  });

  it('writes a transcript part once (If-None-Match), numbered in four digits', async () => {
    const run = store();
    await run.store.writePart(SESSION_ID, 7, '{}');
    expect(run.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'PUT', url: `https://voc-raw.s3.us-west-2.amazonaws.com/scratch/voice/${SESSION_ID}/transcript/part-0007.json`,
      body: '{}', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
    }));
  });

  it('fails with the status only when S3 refuses', async () => {
    const run = store({ request: () => Promise.resolve(new Response('<Error>secret</Error>', { status: 412 })) });
    await expect(run.store.writePart(SESSION_ID, 1, '{}')).rejects.toThrow(new ObjectStoreError('PutObject', 412));
  });
});
