/**
 * Tests for Bedrock ConverseStream wrapper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ── Mocks ──

const mockSend = vi.fn();
const mockConverseStreamCommandCtor = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class MockBedrockRuntimeClient {
    send = mockSend;
    constructor(config: unknown) {
      mockClientCtor(config);
    }
  }

  class MockConverseStreamCommand {
    input: unknown;
    constructor(input: unknown) {
      mockConverseStreamCommandCtor(input);
      this.input = input;
    }
  }

  return {
    BedrockRuntimeClient: MockBedrockRuntimeClient,
    ConverseStreamCommand: MockConverseStreamCommand,
  };
});

import { converseStream, getBedrockClient, resolveChatModelId, supportsPromptCache, type ConverseStreamParams } from './converse-stream.js';
import { nth } from '../lib/nth-fixtures.js';

/** Drain the stream, discarding events — these tests assert on the mocks, not the yields. */
async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }
}

const HI = [{ role: 'user' as const, content: [{ text: 'hi' }] }];

/**
 * One converseStream call against an empty Bedrock stream, returning the
 * ConverseStreamCommand input it built (what every request-shape case asserts on).
 */
async function commandInputFor(params: Partial<ConverseStreamParams>): Promise<unknown> {
  mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });
  await drainStream(converseStream({ messages: HI, systemPrompt: 'test', ...params }));
  return nth(mockConverseStreamCommandCtor.mock.calls, 0)[0];
}

/** Every event converseStream yields for one call over the mocked client. */
async function collectEvents(params: Partial<ConverseStreamParams>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of converseStream({ messages: HI, systemPrompt: 'test', ...params })) {
    collected.push(event);
  }
  return collected;
}

/** The parts of a command input the cache-point case reads, validated rather than assumed. */
const cachedInput = (input: unknown) => z.object({
  toolConfig: z.object({ tools: z.array(z.unknown()) }),
  system: z.array(z.unknown()),
  messages: z.array(z.object({ content: z.array(z.unknown()) })),
}).parse(input);

describe('getBedrockClient', () => {
  it('builds one client with a 5-minute request timeout and reuses it', () => {
    const client1 = getBedrockClient();
    const client2 = getBedrockClient();
    expect(client1).toBe(client2);
    expect(mockClientCtor.mock.calls).toStrictEqual([[{ requestHandler: { requestTimeout: 300_000 } }]]);
  });
});

describe('converseStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields events from the Bedrock stream', async () => {
    const events = [
      { contentBlockDelta: { delta: { text: 'Hello' } } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    mockSend.mockResolvedValueOnce({
      stream: (async function* () {
        for (const e of events) yield e;
      })(),
    });

    const collected = await collectEvents({ systemPrompt: 'You are helpful' });

    expect(collected).toHaveLength(2);
    expect(collected[0]).toStrictEqual(events[0]);
    expect(collected[1]).toStrictEqual(events[1]);
  });

  it('yields nothing when stream is undefined', async () => {
    mockSend.mockResolvedValueOnce({ stream: undefined });

    expect(await collectEvents({})).toHaveLength(0);
  });

  it('passes tools to the command when provided', async () => {
    const tools = [{ toolSpec: { name: 'search_feedback', description: 'Search', inputSchema: { json: {} } } }];

    expect(await commandInputFor({
      tools,
    })).toMatchObject({
      toolConfig: { tools },
    });
  });

  it('omits toolConfig when tools array is empty', async () => {
    expect(await commandInputFor({
      tools: [],
    })).toMatchObject({
      toolConfig: undefined,
    });
  });

  it('uses default maxTokens and thinkingBudget (explicit-budget model)', async () => {
    expect(await commandInputFor({
      modelId: 'global.anthropic.claude-sonnet-4-6',
    })).toMatchObject({
      inferenceConfig: { maxTokens: 16000 },
      additionalModelRequestFields: {
        thinking: { type: 'enabled', budget_tokens: 5000 },
      },
    });
  });

  it('uses custom maxTokens and thinkingBudget when provided', async () => {
    expect(await commandInputFor({
      maxTokens: 4096,
      thinkingBudget: 2000,
      modelId: 'global.anthropic.claude-sonnet-4-6',
    })).toMatchObject({
      inferenceConfig: { maxTokens: 4096 },
      additionalModelRequestFields: {
        thinking: { type: 'enabled', budget_tokens: 2000 },
      },
    });
  });

  it('omits the explicit thinking budget for adaptive-thinking models (Sonnet 5)', async () => {
    // Sonnet 5 runs adaptive thinking always-on and rejects an explicit
    // budget — sending it would 400 every chat turn.
    expect(await commandInputFor({ modelId: 'global.anthropic.claude-sonnet-5' })).not.toHaveProperty('additionalModelRequestFields');
  });

  it('falls back to Sonnet 5.5 when neither an override nor the env is set', () => {
    const saved = process.env.BEDROCK_MODEL_ID;
    delete process.env.BEDROCK_MODEL_ID;
    try {
      expect(resolveChatModelId()).toBe('global.anthropic.claude-sonnet-5-5');
      expect(resolveChatModelId('global.anthropic.claude-opus-5')).toBe('global.anthropic.claude-opus-5');
    } finally {
      process.env.BEDROCK_MODEL_ID = saved;
    }
  });

  it('passes the resolved model override as modelId', async () => {
    expect(await commandInputFor({
      modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    })).toMatchObject({
      modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  });

  it('sends the eu. profile under BEDROCK_INFERENCE_SCOPE=eu, keeping canonical capability checks', async () => {
    vi.stubEnv('BEDROCK_INFERENCE_SCOPE', 'eu');
    try {
      const input = await commandInputFor({ modelId: 'global.anthropic.claude-sonnet-5' });
      expect(input).toMatchObject({ modelId: 'eu.anthropic.claude-sonnet-5' });
      // Sonnet 5 is adaptive: the canonical-id lookup still drops the explicit budget.
      expect(input).not.toHaveProperty('additionalModelRequestFields');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes system prompt as system content block', async () => {
    expect(await commandInputFor({ systemPrompt: 'You are a VoC assistant' })).toMatchObject({
      system: [{ text: 'You are a VoC assistant' }],
    });
  });

  it('passes messages to the command', async () => {
    const messages = [
      { role: 'user' as const, content: [{ text: 'hello' }] },
      { role: 'assistant' as const, content: [{ text: 'hi there' }] },
      { role: 'user' as const, content: [{ text: 'follow up' }] },
    ];

    expect(await commandInputFor({ messages })).toMatchObject({ messages });
  });

  it('places cache points after the tools, the static system block and the history prefix', async () => {
    const tools = [{ toolSpec: { name: 'search_feedback', description: 'Search', inputSchema: { json: {} } } }];
    const messages = [
      { role: 'user' as const, content: [{ text: 'old q' }] },
      { role: 'assistant' as const, content: [{ text: 'old a' }] },
      { role: 'user' as const, content: [{ text: 'new q' }] },
    ];

    const input = cachedInput(await commandInputFor({
      messages, systemPrompt: 'STATIC', systemSuffix: 'DYNAMIC', tools, cache: true, cacheMessageIndex: 1,
      modelId: 'global.anthropic.claude-sonnet-5',
    }));
    expect(input.toolConfig.tools).toStrictEqual([...tools, { cachePoint: { type: 'default' } }]);
    expect(input.system).toStrictEqual([{ text: 'STATIC' }, { cachePoint: { type: 'default' } }, { text: 'DYNAMIC' }]);
    // Only the history prefix (message 1) gains a checkpoint; the newest turn stays as sent.
    expect(input.messages.map((message) => message.content)).toStrictEqual([
      [{ text: 'old q' }],
      [{ text: 'old a' }, { cachePoint: { type: 'default' } }],
      [{ text: 'new q' }],
    ]);
    // The caller's array is not mutated.
    expect(nth(messages, 1).content).toHaveLength(1);
  });

  it('places no cache points when caching is off or the model does not support it', async () => {
    mockSend.mockResolvedValue({ stream: (async function* () {})() });
    const tools = [{ toolSpec: { name: 't', description: 'd', inputSchema: { json: {} } } }];
    await drainStream(converseStream({ messages: [], systemPrompt: 'S', systemSuffix: 'D', tools, cacheMessageIndex: 0 }));
    await drainStream(converseStream({ messages: [], systemPrompt: 'S', tools, cache: true, modelId: 'amazon.nova-pro' }));

    for (const [input] of mockConverseStreamCommandCtor.mock.calls) {
      expect(JSON.stringify(input)).not.toContain('cachePoint');
    }
    expect(supportsPromptCache('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
  });
});

// The mutation run found the history checkpoint's index bounds unpinned: an
// out-of-range index must hand Bedrock the caller's very array, untouched.
describe('converseStream — history checkpoint bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SONNET5 = 'global.anthropic.claude-sonnet-5';
  const TWO = [
    { role: 'user' as const, content: [{ text: 'a' }] },
    { role: 'assistant' as const, content: [{ text: 'b' }] },
  ];
  const messagesSent = async (messages: ConverseStreamParams['messages'], cacheMessageIndex?: number): Promise<unknown> =>
    Reflect.get(z.looseObject({}).parse(
      await commandInputFor({ messages, cache: true, modelId: SONNET5, cacheMessageIndex }),
    ), 'messages');

  it.each([
    ['no index', undefined],
    ['a negative index', -1],
    ['an index one past the end', 2],
  ])('sends the caller\'s array as-is for %s', async (_label, index) => {
    expect(await messagesSent(TWO, index)).toBe(TWO);
  });

  it('checkpoints the first message at index 0', async () => {
    expect(await messagesSent(TWO, 0)).toStrictEqual([
      { role: 'user', content: [{ text: 'a' }, { cachePoint: { type: 'default' } }] },
      TWO[1],
    ]);
  });

  it('gives a message without content just the checkpoint', async () => {
    expect(await messagesSent([{ role: 'user', content: undefined }], 0)).toStrictEqual([
      { role: 'user', content: [{ cachePoint: { type: 'default' } }] },
    ]);
  });
});
