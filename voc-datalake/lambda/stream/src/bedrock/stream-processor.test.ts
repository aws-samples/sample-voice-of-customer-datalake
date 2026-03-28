/**
 * Tests for Bedrock stream event processing.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { createStreamState, processStreamEvent } from './stream-processor.js';

function mockStream() {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream;
}

describe('createStreamState', () => {
  it('returns a fresh state with empty defaults', () => {
    const state = createStreamState();
    expect(state).toEqual({
      stopReason: null,
      toolUseBlocks: [],
      currentToolUseId: null,
      currentToolName: null,
      toolInputChunks: [],
      textContent: '',
    });
  });
});

describe('processStreamEvent', () => {
  describe('text delta', () => {
    it('appends text to state and sends SSE event', () => {
      const state = createStreamState();
      const stream = mockStream();
      const event: ConverseStreamOutput = {
        contentBlockDelta: { delta: { text: 'Hello' }, contentBlockIndex: 0 },
      };

      processStreamEvent(event, state, stream);

      expect(state.textContent).toBe('Hello');
      expect(stream.write).toHaveBeenCalledOnce();
      const written = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('"type":"text"');
      expect(written).toContain('"content":"Hello"');
    });

    it('accumulates multiple text deltas', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent(
        { contentBlockDelta: { delta: { text: 'Hello ' }, contentBlockIndex: 0 } },
        state,
        stream,
      );
      processStreamEvent(
        { contentBlockDelta: { delta: { text: 'world' }, contentBlockIndex: 0 } },
        state,
        stream,
      );

      expect(state.textContent).toBe('Hello world');
      expect(stream.write).toHaveBeenCalledTimes(2);
    });
  });

  describe('thinking delta', () => {
    it('sends thinking SSE event', () => {
      const state = createStreamState();
      const stream = mockStream();
      const event: ConverseStreamOutput = {
        contentBlockDelta: {
          delta: { reasoningContent: { text: 'Let me think...' } },
          contentBlockIndex: 0,
        },
      };

      processStreamEvent(event, state, stream);

      const written = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('"type":"thinking"');
      expect(written).toContain('Let me think...');
    });
  });

  describe('tool use flow', () => {
    it('tracks tool use start, input chunks, and block stop', () => {
      const state = createStreamState();
      const stream = mockStream();

      // 1. Tool use start
      processStreamEvent(
        {
          contentBlockStart: {
            start: { toolUse: { toolUseId: 'tool-1', name: 'search_feedback' } },
            contentBlockIndex: 0,
          },
        },
        state,
        stream,
      );
      expect(state.currentToolUseId).toBe('tool-1');
      expect(state.currentToolName).toBe('search_feedback');

      // 2. Tool input chunks
      processStreamEvent(
        { contentBlockDelta: { delta: { toolUse: { input: '{"query":' } }, contentBlockIndex: 0 } },
        state,
        stream,
      );
      processStreamEvent(
        { contentBlockDelta: { delta: { toolUse: { input: '"delivery"}' } }, contentBlockIndex: 0 } },
        state,
        stream,
      );
      expect(state.toolInputChunks).toEqual(['{"query":', '"delivery"}']);

      // 3. Content block stop — finalizes tool use block
      processStreamEvent({ contentBlockStop: { contentBlockIndex: 0 } }, state, stream);

      expect(state.toolUseBlocks).toHaveLength(1);
      expect(state.toolUseBlocks[0]).toEqual({
        toolUseId: 'tool-1',
        name: 'search_feedback',
        input: { query: 'delivery' },
      });
      expect(state.currentToolUseId).toBeNull();
      expect(state.toolInputChunks).toEqual([]);
    });

    it('handles invalid JSON in tool input gracefully', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent(
        {
          contentBlockStart: {
            start: { toolUse: { toolUseId: 'tool-2', name: 'search_feedback' } },
            contentBlockIndex: 0,
          },
        },
        state,
        stream,
      );
      processStreamEvent(
        { contentBlockDelta: { delta: { toolUse: { input: '{invalid json' } }, contentBlockIndex: 0 } },
        state,
        stream,
      );
      processStreamEvent({ contentBlockStop: { contentBlockIndex: 0 } }, state, stream);

      expect(state.toolUseBlocks[0].input).toEqual({});
    });

    it('handles empty tool input', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent(
        {
          contentBlockStart: {
            start: { toolUse: { toolUseId: 'tool-3', name: 'search_feedback' } },
            contentBlockIndex: 0,
          },
        },
        state,
        stream,
      );
      processStreamEvent({ contentBlockStop: { contentBlockIndex: 0 } }, state, stream);

      expect(state.toolUseBlocks[0].input).toEqual({});
    });
  });

  describe('message stop', () => {
    it('sets stop reason from event', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent(
        { messageStop: { stopReason: 'tool_use' } },
        state,
        stream,
      );

      expect(state.stopReason).toBe('tool_use');
    });

    it('defaults stop reason to end_turn', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent({ messageStop: { stopReason: undefined } }, state, stream);

      expect(state.stopReason).toBe('end_turn');
    });
  });

  describe('unrecognized events', () => {
    it('silently ignores metadata/usage events', () => {
      const state = createStreamState();
      const stream = mockStream();

      processStreamEvent({ metadata: { usage: { inputTokens: 100 } } } as ConverseStreamOutput, state, stream);

      expect(state.textContent).toBe('');
      expect(stream.write).not.toHaveBeenCalled();
    });
  });
});
