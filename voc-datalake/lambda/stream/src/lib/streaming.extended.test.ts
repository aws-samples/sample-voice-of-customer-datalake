/**
 * Extended tests for Lambda streaming utilities.
 *
 * Tests streamifyResponse, wrapStreamWithHeaders, and getAllowedOrigin
 * by mocking the awslambda global that's injected by the Lambda runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to set up the awslambda global before importing the module
const mockStreamifyResponse = vi.fn((handler: Function) => {
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

  it('wrapStreamWithHeaders calls HttpResponseStream.from with correct headers', async () => {
    const { wrapStreamWithHeaders } = await import('./streaming.js');

    const stream = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
    wrapStreamWithHeaders(stream, 'https://example.com');

    expect(mockHttpResponseStreamFrom).toHaveBeenCalledWith(stream, {
      statusCode: 200,
      headers: expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Credentials': 'true',
      }),
    });
  });

  it('wrapStreamWithHeaders uses wildcard origin when ALLOWED_ORIGIN is *', async () => {
    process.env.ALLOWED_ORIGIN = '*';
    const { wrapStreamWithHeaders } = await import('./streaming.js');

    const stream = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
    wrapStreamWithHeaders(stream, 'https://example.com');

    const callArgs = mockHttpResponseStreamFrom.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(callArgs.headers['Access-Control-Allow-Origin']).toBe('*');

    delete process.env.ALLOWED_ORIGIN;
  });

  it('wrapStreamWithHeaders returns matching origin when it matches ALLOWED_ORIGIN', async () => {
    process.env.ALLOWED_ORIGIN = 'https://myapp.com';
    vi.resetModules();
    installAwsLambdaGlobal();
    const { wrapStreamWithHeaders } = await import('./streaming.js');

    const stream = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
    wrapStreamWithHeaders(stream, 'https://myapp.com');

    const callArgs = mockHttpResponseStreamFrom.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(callArgs.headers['Access-Control-Allow-Origin']).toBe('https://myapp.com');

    delete process.env.ALLOWED_ORIGIN;
  });

  it('wrapStreamWithHeaders returns ALLOWED_ORIGIN when request origin does not match', async () => {
    process.env.ALLOWED_ORIGIN = 'https://myapp.com';
    vi.resetModules();
    installAwsLambdaGlobal();
    const { wrapStreamWithHeaders } = await import('./streaming.js');

    const stream = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
    wrapStreamWithHeaders(stream, 'https://evil.com');

    const callArgs = mockHttpResponseStreamFrom.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(callArgs.headers['Access-Control-Allow-Origin']).toBe('https://myapp.com');

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

    const stream = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
    expect(() => wrapStreamWithHeaders(stream)).toThrow(
      'awslambda global not available',
    );
  });
});
