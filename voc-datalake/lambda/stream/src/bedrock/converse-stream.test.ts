/**
 * Tests for Bedrock ConverseStream wrapper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

const mockSend = vi.fn();
const mockConverseStreamCommandCtor = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class MockBedrockRuntimeClient {
    send = mockSend;
    constructor() {
      // no-op
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

import { converseStream, getBedrockClient } from './converse-stream.js';

/** Drain the stream, discarding events — these tests assert on the mocks, not the yields. */
async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }
}

describe('getBedrockClient', () => {
  it('returns a client with a send method', () => {
    const client = getBedrockClient();
    expect(client).toBeDefined();
    expect(typeof client.send).toBe('function');
  });

  it('returns the same instance on subsequent calls (singleton)', () => {
    const client1 = getBedrockClient();
    const client2 = getBedrockClient();
    expect(client1).toBe(client2);
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

    const collected = [];
    for await (const event of converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'You are helpful',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toStrictEqual(events[0]);
    expect(collected[1]).toStrictEqual(events[1]);
  });

  it('yields nothing when stream is undefined', async () => {
    mockSend.mockResolvedValueOnce({ stream: undefined });

    const collected = [];
    for await (const event of converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(0);
  });

  it('passes tools to the command when provided', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    const tools = [{ toolSpec: { name: 'search_feedback', description: 'Search', inputSchema: { json: {} } } }];

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      tools,
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        toolConfig: { tools },
      }),
    );
  });

  it('omits toolConfig when tools array is empty', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      tools: [],
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        toolConfig: undefined,
      }),
    );
  });

  it('uses default maxTokens and thinkingBudget (explicit-budget model)', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      modelId: 'global.anthropic.claude-sonnet-4-6',
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceConfig: { maxTokens: 16000 },
        additionalModelRequestFields: {
          thinking: { type: 'enabled', budget_tokens: 5000 },
        },
      }),
    );
  });

  it('uses custom maxTokens and thinkingBudget when provided', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      maxTokens: 4096,
      thinkingBudget: 2000,
      modelId: 'global.anthropic.claude-sonnet-4-6',
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceConfig: { maxTokens: 4096 },
        additionalModelRequestFields: {
          thinking: { type: 'enabled', budget_tokens: 2000 },
        },
      }),
    );
  });

  it('omits the explicit thinking budget for adaptive-thinking models (Sonnet 5)', async () => {
    // Sonnet 5 runs adaptive thinking always-on and rejects an explicit
    // budget — sending it would 400 every chat turn. It is also the default
    // model, so the no-modelId path must omit the field too.
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      modelId: 'global.anthropic.claude-sonnet-5',
    }));
    // Env default is Sonnet 5.
    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
    }));

    for (const call of mockConverseStreamCommandCtor.mock.calls) {
      expect(call[0]).not.toHaveProperty('additionalModelRequestFields');
    }
  });

  it('passes the resolved model override as modelId', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'test',
      modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      }),
    );
  });

  it('passes system prompt as system content block', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    await drainStream(converseStream({
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      systemPrompt: 'You are a VoC assistant',
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        system: [{ text: 'You are a VoC assistant' }],
      }),
    );
  });

  it('passes messages to the command', async () => {
    mockSend.mockResolvedValueOnce({ stream: (async function* () {})() });

    const messages = [
      { role: 'user' as const, content: [{ text: 'hello' }] },
      { role: 'assistant' as const, content: [{ text: 'hi there' }] },
      { role: 'user' as const, content: [{ text: 'follow up' }] },
    ];

    await drainStream(converseStream({
      messages,
      systemPrompt: 'test',
    }));

    expect(mockConverseStreamCommandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ messages }),
    );
  });
});
