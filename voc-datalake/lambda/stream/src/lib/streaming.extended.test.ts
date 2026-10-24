/**
 * Extended tests for Lambda streaming utilities.
 *
 * Tests streamifyResponse, wrapStreamWithHeaders, and its CORS headers
 * by mocking the awslambda global that's injected by the Lambda runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nth } from './nth-fixtures.js';

// We need to set up the awslambda global before importing the module
type WrappedHandler = (event: unknown, stream: unknown, context: unknown) => unknown;
const mockStreamifyResponse = vi.fn((handler: WrappedHandler) => {
  return (event: unknown, context: unknown) => {
    const stream = { write: vi.fn(), end: vi.fn() };
    return handler(event, stream, context);
  };
});

const mockHttpResponseStreamFrom = vi.fn(
  (responseStream: NodeJS.WritableStream, _metadata: unknown) => responseStream,
);

// Install the global before module import
function installAwsLambdaGlobal() {
  (globalThis as Record<string, unknown>).awslambda = {
    streamifyResponse: mockStreamifyResponse,
    HttpResponseStream: {
      from: mockHttpResponseStreamFrom,
    },
  };
}

function removeAwsLambdaGlobal() {
  delete (globalThis as Record<string, unknown>).awslambda;
}

function mockWritable(): NodeJS.WritableStream {
  return { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
}

/** Wrap a fresh stream and return the metadata handed to HttpResponseStream.from. */
async function wrapAndReadMetadata() {
  const { wrapStreamWithHeaders } = await import('./streaming.js');

  const stream = mockWritable();
  wrapStreamWithHeaders(stream);

  const metadata = nth(mockHttpResponseStreamFrom.mock.calls, 0)[1] as { statusCode: number; headers: Record<string, string> };
  return { stream, metadata };
}

describe('streaming utilities with awslambda global', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAwsLambdaGlobal();
    vi.resetModules();
  });

  afterEach(() => {
    removeAwsLambdaGlobal();
  });

  it('streamifyResponse delegates to awslambda.streamifyResponse', async () => {
    const { streamifyResponse } = await import('./streaming.js');

    const handler = vi.fn();
    streamifyResponse(handler);

    expect(mockStreamifyResponse).toHaveBeenCalledWith(handler);
  });

  it('wrapStreamWithHeaders sends exactly the SSE headers, and * when ALLOWED_ORIGIN is unset', async () => {
    delete process.env.ALLOWED_ORIGIN;
    const { stream } = await wrapAndReadMetadata();

    expect(mockHttpResponseStreamFrom.mock.calls).toStrictEqual([[stream, {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    }]]);
  });

  // Issue #267 item 10: the API's one origin, `Vary: Origin` with a concrete
  // origin, and never `Allow-Credentials` (which was sent with '*' as well).
  it.each([
    ['answers * in a dev deploy', '*', { 'Access-Control-Allow-Origin': '*' }],
    ['answers the frontend origin in production', 'https://myapp.com',
      { 'Access-Control-Allow-Origin': 'https://myapp.com', Vary: 'Origin' }],
  ])('wrapStreamWithHeaders %s, without credentials', async (_label, allowedOrigin, expected) => {
    process.env.ALLOWED_ORIGIN = allowedOrigin;
    vi.resetModules();
    installAwsLambdaGlobal();

    const { metadata } = await wrapAndReadMetadata();
    const cors = Object.entries(metadata.headers)
      .filter(([name]) => name.startsWith('Access-Control-') || name === 'Vary');
    expect(Object.fromEntries(cors)).toStrictEqual(expected);

    delete process.env.ALLOWED_ORIGIN;
  });
});

describe('streaming utilities without awslambda global', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeAwsLambdaGlobal();
    vi.resetModules();
  });

  afterEach(() => {
    removeAwsLambdaGlobal();
  });

  it('streamifyResponse throws when awslambda global is missing', async () => {
    const { streamifyResponse } = await import('./streaming.js');

    expect(() => streamifyResponse(vi.fn())).toThrow(
      'awslambda global not available',
    );
  });

  it('wrapStreamWithHeaders throws when awslambda global is missing', async () => {
    const { wrapStreamWithHeaders } = await import('./streaming.js');

    const stream = mockWritable();
    expect(() => wrapStreamWithHeaders(stream)).toThrow(
      'awslambda global not available',
    );
  });
});

describe('the managed runtime shape', () => {
  afterEach(() => {
    removeAwsLambdaGlobal();
    vi.resetModules();
  });

  // In the real Node runtime HttpResponseStream is a CLASS (typeof 'function'), not a
  // plain object; a guard that demanded an object threw on every cold start (chat 502).
  it('accepts HttpResponseStream as a class with a static from()', async () => {
    class HttpResponseStream {
      static from(responseStream: NodeJS.WritableStream): NodeJS.WritableStream {
        return responseStream;
      }
    }
    (globalThis as Record<string, unknown>).awslambda = { streamifyResponse: mockStreamifyResponse, HttpResponseStream };
    vi.resetModules();
    const { wrapStreamWithHeaders } = await import('./streaming.js');
    const stream = mockWritable();

    expect(wrapStreamWithHeaders(stream)).toBe(stream);
  });

  // Every malformed shape must be refused with the ConfigurationError, not crash on a
  // property read of null or a primitive (a TypeError the handler would not classify).
  it.each([
    ['awslambda is null', null],
    ['awslambda is a string', 'awslambda'],
    ['streamifyResponse is not a function', { streamifyResponse: 'x', HttpResponseStream: { from: mockHttpResponseStreamFrom } }],
    ['HttpResponseStream is null', { streamifyResponse: mockStreamifyResponse, HttpResponseStream: null }],
    ['HttpResponseStream is a string', { streamifyResponse: mockStreamifyResponse, HttpResponseStream: 'from' }],
    ['HttpResponseStream has no from()', { streamifyResponse: mockStreamifyResponse, HttpResponseStream: {} }],
    ['HttpResponseStream.from is not a function', { streamifyResponse: mockStreamifyResponse, HttpResponseStream: { from: 1 } }],
  ])('refuses a runtime where %s', async (_label, runtime) => {
    mockStreamifyResponse.mockClear();
    (globalThis as Record<string, unknown>).awslambda = runtime;
    vi.resetModules();
    const { streamifyResponse } = await import('./streaming.js');
    const { ConfigurationError } = await import('./errors.js');

    expect(() => streamifyResponse(vi.fn())).toThrow(
      new ConfigurationError('awslambda global not available — must run inside Lambda managed runtime'),
    );
    expect(mockStreamifyResponse).not.toHaveBeenCalled();
  });
});
