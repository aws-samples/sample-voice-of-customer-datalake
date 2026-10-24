/**
 * AG-UI event emitter over the SSE response stream.
 *
 * Thin, typed constructors for the events the runtime produces, so the loop
 * reads as protocol steps rather than object literals. Every event gets a
 * millisecond timestamp (the convention every AG-UI SDK uses).
 */
import { EventType, type BaseEvent, type RunFinishedOutcome, type TokenUsage } from '@ag-ui/core';
import { writeSSE } from '../../lib/streaming.js';

export interface Emitter {
  emit(event: BaseEvent): void;
}

export function createStreamEmitter(stream: NodeJS.WritableStream): Emitter {
  return {
    emit(event) {
      writeSSE(stream, { ...event, timestamp: event.timestamp ?? Date.now() });
    },
  };
}

export const events = {
  runStarted: (threadId: string, runId: string, protocolVersion: string): BaseEvent => ({
    type: EventType.RUN_STARTED, threadId, runId, protocolVersion,
  }),
  runFinished: (threadId: string, runId: string, outcome: RunFinishedOutcome, usage: TokenUsage[]): BaseEvent => ({
    type: EventType.RUN_FINISHED, threadId, runId, outcome, ...(usage.length > 0 ? { usage } : {}),
  }),
  runError: (message: string, code: string): BaseEvent => ({ type: EventType.RUN_ERROR, message, code }),
  custom: (name: string, value: unknown): BaseEvent => ({ type: EventType.CUSTOM, name, value }),
  textStart: (messageId: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }),
  textContent: (messageId: string, delta: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }),
  textEnd: (messageId: string): BaseEvent => ({ type: EventType.TEXT_MESSAGE_END, messageId }),
  reasoningStart: (messageId: string): BaseEvent => ({ type: EventType.REASONING_START, messageId }),
  reasoningMessageStart: (messageId: string): BaseEvent => ({
    type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning',
  }),
  reasoningContent: (messageId: string, delta: string): BaseEvent => ({
    type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta,
  }),
  reasoningMessageEnd: (messageId: string): BaseEvent => ({ type: EventType.REASONING_MESSAGE_END, messageId }),
  reasoningEnd: (messageId: string): BaseEvent => ({ type: EventType.REASONING_END, messageId }),
  reasoningEncrypted: (entityId: string, encryptedValue: string): BaseEvent => ({
    type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId, encryptedValue,
  }),
  toolStart: (toolCallId: string, toolCallName: string, parentMessageId: string): BaseEvent => ({
    type: EventType.TOOL_CALL_START, toolCallId, toolCallName, parentMessageId,
  }),
  toolArgs: (toolCallId: string, delta: string): BaseEvent => ({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta }),
  toolEnd: (toolCallId: string): BaseEvent => ({ type: EventType.TOOL_CALL_END, toolCallId }),
  toolResult: (messageId: string, toolCallId: string, content: string): BaseEvent => ({
    type: EventType.TOOL_CALL_RESULT, messageId, toolCallId, content, role: 'tool',
  }),
};

/** Emit a complete tool call (start → full args → end). */
export function emitToolCall(
  emitter: Emitter,
  call: { toolCallId: string; name: string; parentMessageId: string; argsJson: string },
): void {
  emitter.emit(events.toolStart(call.toolCallId, call.name, call.parentMessageId));
  emitter.emit(events.toolArgs(call.toolCallId, call.argsJson));
  emitter.emit(events.toolEnd(call.toolCallId));
}
