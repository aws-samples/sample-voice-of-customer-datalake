/**
 * Records one run's conversation from the AG-UI events the runtime emits, and
 * persists it through a {@link SessionWriter} while the run streams — so a
 * reload, a closed tab or a dropped connection mid-answer finds the answer
 * (partial while running, complete once finished) in `GET /chat/conversations/{id}`.
 *
 * The assistant/tool messages are built the way the SPA's thread reducer
 * builds them (`frontend/src/assistant/thread/reducer.ts`): an assistant
 * message is created on its TEXT_MESSAGE_START or on a TOOL_CALL_START naming
 * it as parent; TOOL_CALL_ARGS deltas concatenate; TOOL_CALL_RESULT appends a
 * `tool` message; REASONING_ENCRYPTED_VALUE lands on `encryptedValue`; the
 * sources / navigation CUSTOM events ride in the last assistant message's
 * `metadata.voc`; an interrupt outcome parks its interrupts as
 * `pendingInterrupts`.
 *
 * Write throttling (never per token): text is flushed every
 * THROTTLE_MS or THROTTLE_CHARS of new text, whichever comes first; tool
 * boundaries (TOOL_CALL_END, TOOL_CALL_RESULT) flush at once; the terminal
 * event flushes the final status. The clock is injected (`nowMs`).
 */
import { EventType, type AssistantMessage, type BaseEvent, type Message, type ToolCall } from '@ag-ui/core';
import { z } from 'zod';
import { CUSTOM_EVENTS, type PageContext } from '../contract.js';
import { buildSessionItem, type RunStatus } from './record.js';
import type { SessionWriter } from './writer.js';

export const THROTTLE_MS = 2000;
export const THROTTLE_CHARS = 2000;

export interface RecorderBase {
  callerSub: string;
  threadId: string;
  runId: string;
  page: PageContext;
  /** The thread before this run's output: stored history + the newest user turn (and resume tool messages). */
  history: readonly Message[];
  createdAt: string;
}

export interface SessionRecorder {
  /** Fold one event; returns the revision of the write it queued, or null. */
  observe(event: BaseEvent): number | null;
  /** Queue a write of the current state now (the run's first write: the user turn). */
  flush(): number;
}

const textStart = z.object({ messageId: z.string() });
const textContent = z.object({ messageId: z.string(), delta: z.string() });
const toolStart = z.object({ toolCallId: z.string(), toolCallName: z.string(), parentMessageId: z.string().optional() });
const toolArgs = z.object({ toolCallId: z.string(), delta: z.string() });
const toolResult = z.object({ messageId: z.string(), toolCallId: z.string(), content: z.unknown() });
const encrypted = z.object({ subtype: z.string(), entityId: z.string(), encryptedValue: z.string() });
const custom = z.object({ name: z.string(), value: z.unknown() });
const finished = z.object({
  outcome: z.object({ type: z.string(), interrupts: z.array(z.unknown()).optional() }).optional(),
});

interface RecorderState {
  messages: Message[];
  lastAssistantId: string | null;
  pending: unknown[];
  status: RunStatus;
  lastFlushMs: number;
  charsSinceFlush: number;
  sources: unknown;
  navigation: unknown[];
}

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant';
}

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export function createSessionRecorder(base: RecorderBase, writer: SessionWriter, nowMs: () => number): SessionRecorder {
  const state: RecorderState = {
    messages: [], lastAssistantId: null, pending: [], status: 'running',
    lastFlushMs: nowMs(), charsSinceFlush: 0, sources: undefined, navigation: [],
  };

  function ensureAssistant(id: string): void {
    state.lastAssistantId = id;
    if (!state.messages.some((m) => m.id === id)) state.messages.push({ id, role: 'assistant', content: '' });
  }

  function updateAssistant(id: string, update: (m: AssistantMessage) => AssistantMessage): void {
    state.messages = state.messages.map((m) => (m.id === id && isAssistant(m) ? update(m) : m));
  }

  function updateToolCall(toolCallId: string, update: (call: ToolCall) => ToolCall): void {
    // The inner map changes only the call with this id, so every message with tool calls can go through it.
    state.messages = state.messages.map((m) => (isAssistant(m) && m.toolCalls
      ? { ...m, toolCalls: m.toolCalls.map((c) => (c.id === toolCallId ? update(c) : c)) }
      : m));
  }

  /** The run's output with sources/navigation on the last assistant message, as the SPA stores them. */
  function outputMessages(): Message[] {
    const anchor = state.lastAssistantId;
    const hasSources = state.sources !== undefined;
    const hasNavigation = state.navigation.length > 0;
    // A null anchor matches no message id, so the map below leaves the list as it is.
    if (!hasSources && !hasNavigation) return state.messages;
    const voc = { ...(hasSources ? { sources: state.sources } : {}), ...(hasNavigation ? { navigation: state.navigation } : {}) };
    return state.messages.map((m) => (m.id === anchor && isAssistant(m) ? { ...m, metadata: { ...m.metadata, voc } } : m));
  }

  function flush(): number {
    state.lastFlushMs = nowMs();
    state.charsSinceFlush = 0;
    const snapshot = {
      callerSub: base.callerSub,
      threadId: base.threadId,
      runId: base.runId,
      status: state.status,
      messages: [...base.history, ...outputMessages()],
      page: base.page,
      pendingInterrupts: state.pending,
      createdAt: base.createdAt,
      updatedAt: new Date(state.lastFlushMs).toISOString(),
    };
    return writer.enqueue((revision) => buildSessionItem({ ...snapshot, revision }));
  }

  function onText(event: BaseEvent): number | null {
    const parsed = textContent.safeParse(event);
    if (!parsed.success) return null;
    ensureAssistant(parsed.data.messageId);
    updateAssistant(parsed.data.messageId, (m) => ({ ...m, content: [m.content, parsed.data.delta].join('') }));
    state.charsSinceFlush += parsed.data.delta.length;
    const due = nowMs() - state.lastFlushMs >= THROTTLE_MS || state.charsSinceFlush >= THROTTLE_CHARS;
    return due ? flush() : null;
  }

  function onToolStart(event: BaseEvent): void {
    const parsed = toolStart.safeParse(event);
    if (!parsed.success) return;
    const { toolCallId, toolCallName, parentMessageId } = parsed.data;
    const parentId = parentMessageId ?? state.lastAssistantId ?? `assistant-${toolCallId}`;
    ensureAssistant(parentId);
    const call: ToolCall = { id: toolCallId, type: 'function', function: { name: toolCallName, arguments: '' } };
    updateAssistant(parentId, (m) => ({ ...m, toolCalls: [...(m.toolCalls ?? []), call] }));
  }

  function onToolResult(event: BaseEvent): number | null {
    const parsed = toolResult.safeParse(event);
    if (!parsed.success) return null;
    const { messageId, toolCallId, content } = parsed.data;
    state.messages.push({ id: messageId, role: 'tool', toolCallId, content: contentText(content) });
    return flush();
  }

  function onCustom(event: BaseEvent): void {
    const parsed = custom.safeParse(event);
    if (!parsed.success) return;
    if (parsed.data.name === CUSTOM_EVENTS.sources) state.sources = parsed.data.value;
    if (parsed.data.name === CUSTOM_EVENTS.navigation) state.navigation.push(parsed.data.value);
  }

  function onFinished(event: BaseEvent): number {
    const parsed = finished.safeParse(event);
    const outcome = parsed.success ? parsed.data.outcome : undefined;
    const interrupts = outcome?.type === 'interrupt' ? outcome.interrupts ?? [] : [];
    state.pending = interrupts;
    state.status = interrupts.length > 0 ? 'interrupted' : 'finished';
    return flush();
  }

  function onEncrypted(event: BaseEvent): void {
    const parsed = encrypted.safeParse(event);
    if (!parsed.success || parsed.data.subtype !== 'message') return;
    ensureAssistant(parsed.data.entityId);
    updateAssistant(parsed.data.entityId, (m) => ({ ...m, encryptedValue: parsed.data.encryptedValue }));
  }

  function onToolArgs(event: BaseEvent): void {
    const parsed = toolArgs.safeParse(event);
    if (!parsed.success) return;
    updateToolCall(parsed.data.toolCallId, (c) => ({ ...c, function: { ...c.function, arguments: c.function.arguments + parsed.data.delta } }));
  }

  function onTextStart(event: BaseEvent): void {
    const parsed = textStart.safeParse(event);
    if (parsed.success) ensureAssistant(parsed.data.messageId);
  }

  type Handler = (event: BaseEvent) => number | null;
  /** Events that only change state queue no write. */
  const quiet = (fn: (event: BaseEvent) => void): Handler => (event) => {
    fn(event);
    return null;
  };
  const handlers: Partial<Record<string, Handler>> = {
    [EventType.TEXT_MESSAGE_START]: quiet(onTextStart),
    [EventType.TEXT_MESSAGE_CONTENT]: onText,
    [EventType.TOOL_CALL_START]: quiet(onToolStart),
    [EventType.TOOL_CALL_ARGS]: quiet(onToolArgs),
    [EventType.TOOL_CALL_END]: () => flush(),
    [EventType.TOOL_CALL_RESULT]: onToolResult,
    [EventType.REASONING_ENCRYPTED_VALUE]: quiet(onEncrypted),
    [EventType.CUSTOM]: quiet(onCustom),
    [EventType.RUN_FINISHED]: onFinished,
    [EventType.RUN_ERROR]: () => {
      state.status = 'failed';
      return flush();
    },
  };

  return {
    observe(event) {
      // Once terminal, nothing changes the stored record any more.
      if (state.status !== 'running') return null;
      return handlers[event.type]?.(event) ?? null;
    },
    flush,
  };
}
