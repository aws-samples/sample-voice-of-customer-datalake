/**
 * Tests for the SSE frame writer.
 *
 * streamifyResponse / wrapStreamWithHeaders depend on the Lambda runtime
 * global and are covered in streaming.extended.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HEARTBEAT_FRAME, HEARTBEAT_INTERVAL_MS, startHeartbeat, writeSSE } from './streaming.js';
import { nth } from './nth-fixtures.js';

function mockStream() {
  return { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream & {
    write: ReturnType<typeof vi.fn>;
  };
}

describe('writeSSE', () => {
  it('writes one data frame terminated by a blank line', () => {
    const stream = mockStream();
    writeSSE(stream, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' });
    expect(stream.write).toHaveBeenCalledWith(
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}\n\n',
    );
  });

  it('serialises nested payloads as a single line of JSON', () => {
    const stream = mockStream();
    writeSSE(stream, { type: 'CUSTOM', name: 'x', value: { list: [1, 2], text: 'a\nb' } });
    const frame = String(nth(stream.write.mock.calls, 0)[0]);
    expect(frame.split('\n')).toHaveLength(3);
    expect(JSON.parse(frame.slice('data: '.length))).toStrictEqual({
      type: 'CUSTOM', name: 'x', value: { list: [1, 2], text: 'a\nb' },
    });
  });
});

describe('startHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats well inside the 30 s idle cut of an edge-optimized API', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('is an SSE comment frame, which every parser skips', () => {
    expect(HEARTBEAT_FRAME.startsWith(':')).toBe(true);
    expect(HEARTBEAT_FRAME.endsWith('\n\n')).toBe(true);
  });

  it('writes one comment per interval until stopped', () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const stop = startHeartbeat(stream, 1000);

    vi.advanceTimersByTime(999);
    expect(stream.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2001);
    expect(stream.write.mock.calls).toStrictEqual([[HEARTBEAT_FRAME], [HEARTBEAT_FRAME], [HEARTBEAT_FRAME]]);

    stop();
    vi.advanceTimersByTime(10_000);
    expect(stream.write).toHaveBeenCalledTimes(3);
  });

  it('never holds the runtime open: the interval is unref()d', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = startHeartbeat(mockStream(), 1000);
    const timer = setIntervalSpy.mock.results[0]?.value;
    const holdsRuntime = timer?.hasRef();
    stop();
    setIntervalSpy.mockRestore();

    expect(holdsRuntime).toBe(false);
  });
});
