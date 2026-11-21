/**
 * The deployment's own models in the stream Lambda (7.65.00, custom-models.ts): the registry read from
 * `CUSTOM_MODELS` (the fixture the CDK spec and the Python suites read too), the per-surface pick it allows (a
 * declared surface, with tools), and how each request to it is shaped: no thinking field, its output cap, and no
 * attachment to a model that reads none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { supportsDocumentBlocks } from '../assistant/runtime/library-mentions.js';
import {
  capOutputTokens, customContextWindow, customModel, customModels, CUSTOM_MODELS_ENV, DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS, MAX_CUSTOM_MODELS, readsAttachments, streamCustomModel,
} from './custom-models.js';
import { CHAT_SURFACE_DEFAULT, chatModelForAttachments, fallbackChain } from './model-fallback.js';
import { takesThinkingBudget } from './model-override.js';

const REGISTRY = readFileSync(join(__dirname, '..', '..', '..', '..', 'lib', 'test-support', 'custom-models-env.json'), 'utf8');
const NOVA = 'amazon.nova-pro-v1:0';                        // documents, utility, prototype; no tools
const LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0';         // chat, agent_worker, enrichment; tools, no documents
const MINE = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456';
const SONNET46 = 'global.anthropic.claude-sonnet-4-6';
const SONNET55 = 'global.anthropic.claude-sonnet-5-5';

beforeEach(() => {
  vi.stubEnv(CUSTOM_MODELS_ENV, REGISTRY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('customModels', () => {
  it('reads the registry in order with each output cap', () => {
    expect(customModels().map((model) => [model.id, model.tools, model.documents, model.maxOutputTokens])).toStrictEqual([
      [NOVA, false, true, 10_000], [LLAMA, true, false, 8_192], [MINE, false, false, 2_048],
    ]);
  });

  it('reads each window, the synth\'s default when an entry names none, and none for a Claude', () => {
    const noWindow = JSON.stringify([{ key: 'x', id: 'amazon.nova-lite-v1:0', label: 'Lite', surfaces: ['chat'],
      capabilities: { tools: true, documents: false, json: true, temperature: true } }]);
    expect([customContextWindow(LLAMA), customContextWindow(MINE), customContextWindow(SONNET55),
      customModels(noWindow)[0]?.contextWindow]).toStrictEqual([128_000, 8_192, undefined, DEFAULT_CONTEXT_WINDOW]);
  });

  it('reads nothing without the env, from a value that is not JSON or not a list', () => {
    for (const raw of ['', '{not json', '{"id": "x"}']) expect(customModels(raw)).toStrictEqual([]);
  });

  it('skips an entry it cannot read or that repeats an id, and reads at most the synth limit', () => {
    const [nova, llama] = JSON.parse(REGISTRY) as unknown[];
    expect(customModels(JSON.stringify([{ id: 'x' }, nova, nova, llama])).map((model) => model.id)).toStrictEqual([NOVA, LLAMA]);
    const many = Array.from({ length: MAX_CUSTOM_MODELS + 2 }, (_, i) => ({ ...(nova as object), id: `m${String(i)}` }));
    expect(customModels(JSON.stringify(many))).toHaveLength(MAX_CUSTOM_MODELS);
    const uncapped = { ...(nova as object), id: 'uncapped', maxOutputTokens: undefined };
    expect(customModels(JSON.stringify([uncapped])).at(0)?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

describe('the pick and the request', () => {
  it('runs a custom model only on a surface it declares, and only with tools', () => {
    expect([streamCustomModel(LLAMA, 'chat'), streamCustomModel(LLAMA, 'agent_worker')]).toStrictEqual([LLAMA, LLAMA]);
    expect(streamCustomModel(LLAMA, 'documents')).toBeUndefined();
    expect(streamCustomModel(NOVA, 'documents')).toBeUndefined();   // no tools
    expect(streamCustomModel(SONNET55, 'chat')).toBeUndefined();
  });

  it('never sends a custom model a thinking budget, nor an adaptive Claude', () => {
    expect([LLAMA, NOVA, MINE, SONNET55].map(takesThinkingBudget)).toStrictEqual([false, false, false, false]);
    expect(takesThinkingBudget(SONNET46)).toBe(true);
  });

  it('caps maxTokens at a custom model\'s output only', () => {
    expect([capOutputTokens(MINE, 16_000), capOutputTokens(LLAMA, 100), capOutputTokens(SONNET55, 16_000)])
      .toStrictEqual([2_048, 100, 16_000]);
  });

  it('sends attachments and library documents only to a model that reads them', () => {
    expect([readsAttachments(LLAMA), readsAttachments(NOVA), readsAttachments(SONNET55)]).toStrictEqual([false, true, true]);
    expect([supportsDocumentBlocks(LLAMA), supportsDocumentBlocks(NOVA), supportsDocumentBlocks(SONNET55)])
      .toStrictEqual([false, true, true]);
  });

  it('runs a turn with attachments on the chat default when the custom model reads none', () => {
    expect([chatModelForAttachments(LLAMA, true), chatModelForAttachments(LLAMA, false), chatModelForAttachments(SONNET46, true)])
      .toStrictEqual([CHAT_SURFACE_DEFAULT, LLAMA, SONNET46]);
  });

  it('falls back from a custom model to Claude models only', () => {
    const [first, ...rest] = fallbackChain(LLAMA);
    expect(first).toBe(LLAMA);
    expect(rest.every((model) => model.startsWith('global.anthropic.'))).toBe(true);
    expect(customModel(rest.at(0))).toBeUndefined();
  });
});

describe('resolveModelOverride with custom models', () => {
  /** A table whose picks' row is `item` (the deployment default absent). */
  function tableWith(item: Record<string, unknown>): DynamoDBDocumentClient {
    const send = vi.fn((command: { input: { Key: { pk: string } } }) =>
      Promise.resolve({ Item: command.input.Key.pk === 'SETTINGS#model' ? item : undefined }));
    return Object.assign(Object.create(null) as object, { send }) as unknown as DynamoDBDocumentClient;
  }

  it('resolves a declared custom pick, and ignores one for an undeclared surface or for all surfaces', async () => {
    vi.resetModules();
    const { resolveModelOverride } = await import('./model-override.js');
    expect(await resolveModelOverride(tableWith({ surfaces: { chat: LLAMA } }), 'agg', 'chat')).toBe(LLAMA);
    vi.resetModules();
    const fresh = await import('./model-override.js');
    expect(await fresh.resolveModelOverride(tableWith({ surfaces: { chat: NOVA }, model_id: LLAMA }), 'agg', 'chat'))
      .toBeUndefined();
  });
});
