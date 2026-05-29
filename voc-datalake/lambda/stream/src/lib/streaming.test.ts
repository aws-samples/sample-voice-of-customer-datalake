/**
 * Tests for SSE streaming utilities.
 *
 * Note: streamifyResponse and wrapStreamWithHeaders depend on the
 * `awslambda` global which only exists in the Lambda runtime.
 * We test the pure functions: sendSSE and sendErrorAndClose.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendSSE, sendErrorAndClose } from './streaming.js';

function mockStream() {
  return {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as NodeJS.WritableStream;
}

describe('sendSSE', () => {
  it('writes a properly formatted SSE data line', () => {
    const stream = mockStream();
    sendSSE(stream, { type: 'text', content: 'hello' });

    expect(stream.write).toHaveBeenCalledOnce();
    const written = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toBe('data: {"type":"text","content":"hello"}\n\n');
  });

  it('serializes complex objects', () => {
    const stream = mockStream();
    sendSSE(stream, { type: 'metadata', metadata: { count: 42, items: [1, 2] } });

    const written = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(written.replace('data: ', '').trim());
    expect(parsed.type).toBe('metadata');
    expect(parsed.metadata.count).toBe(42);
  });
});

describe('sendErrorAndClose', () => {
  it('sends error event, done event, and closes stream', () => {
    const stream = mockStream();
    sendErrorAndClose(stream, 'something failed', 'ValidationError', 400);

    const writeCalls = (stream.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls).toHaveLength(2);

    // First call: error event
    const errorEvent = JSON.parse((writeCalls[0][0] as string).replace('data: ', '').trim());
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.error).toBe('something failed');
    expect(errorEvent.errorType).toBe('ValidationError');
    expect(errorEvent.statusCode).toBe(400);
    expect(errorEvent.success).toBe(false);

    // Second call: done event
    const doneEvent = JSON.parse((writeCalls[1][0] as string).replace('data: ', '').trim());
    expect(doneEvent.type).toBe('done');

    // Stream closed
    expect(stream.end).toHaveBeenCalledOnce();
  });

  it('omits errorType and statusCode when not provided', () => {
    const stream = mockStream();
    sendErrorAndClose(stream, 'generic error');

    const writeCalls = (stream.write as ReturnType<typeof vi.fn>).mock.calls;
    const errorEvent = JSON.parse((writeCalls[0][0] as string).replace('data: ', '').trim());
    expect(errorEvent.errorType).toBeUndefined();
    expect(errorEvent.statusCode).toBeUndefined();
  });
});
