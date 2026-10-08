/**
 * Handler wiring: the Lambda entry streams an AG-UI run through the real
 * runtime, resolves the `chat` surface model, and always closes the stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

const { mockConverseStream, mockResolveModelOverride, mockIsWebSearchConfigured, mockStartHeartbeat, mockStopHeartbeat, mockDocFrom, docSend, fakeDocClient } = vi.hoisted(() => {
  // The handler's one document client, so its options and the session writes are visible.
  const send = vi.fn();
  return {
    mockConverseStream: vi.fn(),
    mockResolveModelOverride: vi.fn(),
    mockIsWebSearchConfigured: vi.fn(),
    mockStartHeartbeat: vi.fn(),
    mockStopHeartbeat: vi.fn(),
    mockDocFrom: vi.fn(),
    docSend: send,
    fakeDocClient: { send },
  };
});

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>()),
  DynamoDBDocumentClient: { from: mockDocFrom.mockReturnValue(fakeDocClient) },
}));

vi.mock('./lib/streaming.js', () => ({
  streamifyResponse: (handler: unknown) => handler,
  wrapStreamWithHeaders: (stream: NodeJS.WritableStream) => stream,
  writeSSE: (stream: NodeJS.WritableStream, payload: unknown) => stream.write(`data: ${JSON.stringify(payload)}\n\n`),
  startHeartbeat: mockStartHeartbeat,
}));

vi.mock('./bedrock/converse-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bedrock/converse-stream.js')>()),
  converseStream: mockConverseStream,
}));

// Partial: the allowlist and capability sets stay real (the model fallback chain reads them).
vi.mock('./bedrock/model-override.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bedrock/model-override.js')>()),
  resolveModelOverride: mockResolveModelOverride,
}));
vi.mock('./tools/web-search.js', () => ({ isWebSearchConfigured: mockIsWebSearchConfigured }));

import { handler } from './handler.js';

function mockStream() {
  return { write: vi.fn(), end: vi.fn() };
}

function frames(stream: ReturnType<typeof mockStream>): Record<string, unknown>[] {
  return stream.write.mock.calls.map(([frame]) => JSON.parse(String(frame).slice('data: '.length)));
}

const body = {
  threadId: 't', runId: 'r', tools: [], context: [],
  messages: [{ id: 'u', role: 'user', content: 'hello' }],
  forwardedProps: { page: { kind: 'home', path: '/' }, useWebSearch: true },
};

/** A run that answers "Hi!" with the chat model, logs silenced. */
function primeMocks(): void {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockResolveModelOverride.mockResolvedValue('global.anthropic.claude-opus-5');
  mockIsWebSearchConfigured.mockReturnValue(false);
  mockStartHeartbeat.mockReturnValue(mockStopHeartbeat);
  mockConverseStream.mockImplementation(async function* () {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi!' } } };
    yield { messageStop: { stopReason: 'end_turn' } };
  });
  docSend.mockResolvedValue({});
}

const signedInEvent = { body: JSON.stringify(body), requestContext: { authorizer: { claims: { sub: 'u1' } } } };

describe('handler', () => {
  beforeEach(primeMocks);

  async function runOk(): Promise<{ stream: ReturnType<typeof mockStream>; events: Record<string, unknown>[] }> {
    const stream = mockStream();
    await handler(signedInEvent, stream);
    return { stream, events: frames(stream) };
  }

  it('streams a full AG-UI run and closes the stream', async () => {
    const { stream, events } = await runOk();

    expect(events.map((e) => e.type)).toStrictEqual([
      'RUN_STARTED', 'CUSTOM', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'CUSTOM', 'RUN_FINISHED',
    ]);
    expect(stream.end).toHaveBeenCalledExactlyOnceWith();
  });

  it('resolves the chat surface model and streams Bedrock with it, cached', async () => {
    const { events } = await runOk();

    expect(events[1]).toMatchObject({ value: { model: 'global.anthropic.claude-opus-5', webSearch: false } });
    expect(mockResolveModelOverride).toHaveBeenCalledWith(fakeDocClient, '', 'chat');
    expect(mockConverseStream).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'global.anthropic.claude-opus-5', cache: true }));
  });

  it('keeps the stream alive for the whole run and stops the heartbeat before closing', async () => {
    const order: string[] = [];
    mockStopHeartbeat.mockImplementation(() => order.push('stop'));
    const stream = mockStream();
    stream.end.mockImplementation(() => order.push('end'));
    await handler(signedInEvent, stream);

    expect(mockStartHeartbeat).toHaveBeenCalledExactlyOnceWith(stream);
    expect(order).toStrictEqual(['stop', 'end']);
  });

  it('stops the heartbeat even when the request is bad', async () => {
    await handler({ body: '[]' }, mockStream());
    expect(mockStopHeartbeat).toHaveBeenCalledExactlyOnceWith();
  });

  it('ends with RUN_ERROR and still closes the stream on a bad request', async () => {
    const stream = mockStream();
    await handler({ body: '[]' }, stream);
    expect(frames(stream)).toStrictEqual([expect.objectContaining({ type: 'RUN_ERROR', code: 'invalid_request' })]);
    expect(stream.end).toHaveBeenCalledExactlyOnceWith();
  });

  it('logs one invocation_cost line per run (the sizing policy CPU figure), with no content', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '1024');
    try {
      await runOk();
    } finally {
      vi.unstubAllEnvs();
    }
    const logSpy = vi.mocked(console.log);
    const costLines = logSpy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"invocation_cost"'));
    expect(costLines).toHaveLength(1);
    expect(JSON.parse(costLines[0] ?? '')).toMatchObject({ message: 'invocation_cost', function_memory_size: 1024 });
    expect(costLines[0]).not.toContain('hello');
  });
});

describe('handler wiring read at module load', () => {
  const NOW = new Date('2026-03-04T05:06:07.000Z');

  async function freshHandler(env: Record<string, string>): Promise<typeof handler> {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return (await import('./handler.js')).handler;
  }

  beforeEach(() => {
    primeMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });


  it('builds one document client that drops undefined attributes', async () => {
    await freshHandler({});

    expect(mockDocFrom).toHaveBeenCalledExactlyOnceWith(expect.any(DynamoDBClient), { marshallOptions: { removeUndefinedValues: true } });
  });

  it('saves the session to the conversations table, clocked by the real time', async () => {
    const fresh = await freshHandler({ CONVERSATIONS_TABLE: 'voc-conversations' });
    await fresh(signedInEvent, mockStream());

    const puts = docSend.mock.calls.map(([command]: unknown[]) => command).filter((command) => command instanceof PutCommand);
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(puts.map((command) => command.input.TableName)).toStrictEqual(puts.map(() => 'voc-conversations'));
    expect(puts.at(-1)?.input.Item).toMatchObject({ pk: 'USER#u1', created_at: NOW.toISOString() });
  });

  it('saves nothing when no conversations table is configured', async () => {
    const fresh = await freshHandler({});
    await fresh(signedInEvent, mockStream());

    expect(docSend).not.toHaveBeenCalled();
  });
});
