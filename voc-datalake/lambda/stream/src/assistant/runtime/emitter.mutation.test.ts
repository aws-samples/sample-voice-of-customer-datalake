/**
 * Emitter pins the mutation run found missing: no spec built RUN_FINISHED
 * without usage, checked the reasoning message role, or saw TOOL_CALL_END of
 * `emitToolCall` — so an empty `usage: []` on the wire, a blank role, or a
 * tool call that never closes all passed.
 */
import { describe, expect, it } from 'vitest';
import { recordingEmitter } from './__fixtures__/fakes.js';
import { emitToolCall, events } from './emitter.js';

describe('events', () => {
  it('leaves usage off RUN_FINISHED when there is none', () => {
    expect(events.runFinished('t', 'r', { type: 'success' }, [])).toStrictEqual({
      type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' },
    });
  });

  it('opens a reasoning message with the reasoning role', () => {
    expect(events.reasoningMessageStart('m1')).toStrictEqual({ type: 'REASONING_MESSAGE_START', messageId: 'm1', role: 'reasoning' });
  });
});

describe('emitToolCall', () => {
  it('emits start, the full args and end, in that order', () => {
    const { emitter, events: emitted } = recordingEmitter();
    emitToolCall(emitter, { toolCallId: 'c1', name: 'search_feedback', parentMessageId: 'm1', argsJson: '{"q":1}' });
    expect(emitted).toStrictEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'search_feedback', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"q":1}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
    ]);
  });
});
