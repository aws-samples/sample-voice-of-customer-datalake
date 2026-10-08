/**
 * CROSS-SIDE: the signed thinking block survives SPA → resume → Bedrock.
 *
 * The SPA's own thread reducer and wire sanitiser (frontend/src/assistant/thread)
 * consume the events this runtime emits for a tool-using turn; their output is
 * then parsed by this runtime's real input parser and tail builder. The result
 * must be a Bedrock assistant message whose reasoning block (text + signature,
 * exactly as Bedrock produced it) precedes its toolUse — what Claude requires
 * when a tool loop is continued.
 *
 * The frontend modules are loaded with a runtime `import()` (Vitest resolves
 * them, with the frontend's own dependencies), not a static import: the stream
 * tsconfig must not type-check another package's sources. Their exports are
 * checked with type guards and their output re-validated by the AG-UI schema.
 */
import { describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import { MessageSchema } from '@ag-ui/core/schemas';
import { z } from 'zod';
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { BaseEvent, Message, UserMessage } from '@ag-ui/core';
import { parseRunInput } from './__fixtures__/fakes.js';
import { nth } from '../../lib/nth-fixtures.js';
import { lastUserIndex } from './input.js';
import { encodeReasoning } from './reasoning.js';
import { buildTail } from './tail.js';

/** voc-datalake/frontend/src/assistant/thread, resolved from this file (runtime → … → voc-datalake). */
const FRONTEND_THREAD = new URL('../../../../../frontend/src/assistant/thread/', import.meta.url);

type Reduce = (state: unknown, action: unknown) => unknown;
type Create = (threadId: string) => unknown;
type ToWire = (messages: unknown) => unknown;

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

async function loadSpaThread(): Promise<{ create: Create; reduce: Reduce; toWire: ToWire }> {
  const reducerUrl = new URL('reducer.ts', FRONTEND_THREAD).href;
  const wireUrl = new URL('wire.ts', FRONTEND_THREAD).href;
  const reducer: Record<string, unknown> = await import(/* @vite-ignore */ reducerUrl);
  const wire: Record<string, unknown> = await import(/* @vite-ignore */ wireUrl);
  const { createThreadState, threadReducer } = reducer;
  const { toWireMessages } = wire;
  if (!isFunction(createThreadState) || !isFunction(threadReducer) || !isFunction(toWireMessages)) {
    throw new Error('SPA thread modules no longer export createThreadState / threadReducer / toWireMessages');
  }
  return {
    create: (threadId) => Reflect.apply(createThreadState, undefined, [threadId]),
    reduce: (state, action) => Reflect.apply(threadReducer, undefined, [state, action]),
    toWire: (messages) => Reflect.apply(toWireMessages, undefined, [messages]),
  };
}

const stateMessagesSchema = z.object({ messages: z.array(z.unknown()) });

const SIGNED_TURN: ContentBlock[] = [
  { reasoningContent: { reasoningText: { text: 'The user wants the PRD renamed.', signature: 'sig-abc' } } },
  { toolUse: { toolUseId: 'tu_1', name: 'update_project', input: { project_id: 'p1', name: 'Checkout v2' } } },
];

function serverEvents(encryptedValue: string): BaseEvent[] {
  const args = JSON.stringify({ project_id: 'p1', name: 'Checkout v2' });
  return [
    { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: 'run-1' },
    { type: EventType.REASONING_START, messageId: 'rs1' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'rs1', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'rs1', delta: 'The user wants the PRD renamed.' },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'rs1' },
    { type: EventType.REASONING_END, messageId: 'rs1' },
    // Emitted before the tool calls, as loop.ts does; this turn has no text.
    { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'm1', encryptedValue },
    { type: EventType.TOOL_CALL_START, toolCallId: 'tu_1', toolCallName: 'update_project', parentMessageId: 'm1' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tu_1', delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: 'tu_1' },
    {
      type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1',
      outcome: { type: 'interrupt', interrupts: [{ id: 'approval:tu_1', reason: 'tool_approval', toolCallId: 'tu_1' }] },
    },
  ];
}

async function spaWireMessages(): Promise<Message[]> {
  const spa = await loadSpaThread();
  const encrypted = encodeReasoning(SIGNED_TURN);
  if (encrypted === undefined) throw new Error('encodeReasoning produced nothing for a signed turn');
  const user: UserMessage = { id: 'u1', role: 'user', content: 'Rename the project to Checkout v2' };
  const outcome: Message = {
    id: 'tm1', role: 'tool', toolCallId: 'tu_1',
    content: JSON.stringify({ status: 'executed', summary: 'Renamed the project' }),
  };
  const actions = [
    { type: 'local/user_message', message: user },
    ...serverEvents(encrypted).map((event) => ({ type: 'event', event })),
    { type: 'local/apply_resolutions', toolMessages: [outcome] },
  ];
  const state = actions.reduce<unknown>((acc, action) => spa.reduce(acc, action), spa.create('thread-1'));
  const wire = spa.toWire(stateMessagesSchema.parse(state).messages);
  if (!Array.isArray(wire)) throw new Error('toWireMessages did not return an array');
  // AG-UI's schemas are zod 4 (ours is zod 3), so validate entry by entry.
  return wire.map((entry: unknown) => MessageSchema.parse(entry));
}

function splitAtLastUser(messages: Message[]): { user: UserMessage; after: Message[] } {
  const index = lastUserIndex(messages);
  const user = nth(messages, index);
  if (user.role !== 'user') throw new Error('no user message in the parsed run');
  return { user, after: messages.slice(index + 1) };
}

describe('SPA reducer → wire → server tail (reasoning round trip)', () => {
  it('carries the encrypted value on the SPA assistant message unchanged', async () => {
    const messages = await spaWireMessages();
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toMatchObject({ id: 'm1', encryptedValue: encodeReasoning(SIGNED_TURN) });
  });

  it('rebuilds a Bedrock assistant message with the signed reasoning block before the toolUse', async () => {
    const messages = await spaWireMessages();
    const body = JSON.stringify({
      threadId: 'thread-1', runId: 'run-2', state: {}, tools: [], context: [], messages,
      resume: [{ interruptId: 'approval:tu_1', status: 'resolved', payload: { approved: true } }],
      forwardedProps: { page: { kind: 'project', path: '/projects/p1', projectId: 'p1' } },
    });
    const { input } = parseRunInput(body);
    const { user, after } = splitAtLastUser(input.messages);

    const tail = buildTail(user, after, input.resume ?? [], 'structured');

    expect(tail.messages[1]).toStrictEqual({
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: 'The user wants the PRD renamed.', signature: 'sig-abc' } } },
        { toolUse: { toolUseId: 'tu_1', name: 'update_project', input: { project_id: 'p1', name: 'Checkout v2' } } },
      ],
    });
    expect(tail.messages[2]).toStrictEqual({
      role: 'user',
      content: [{ toolResult: { toolUseId: 'tu_1', content: [{ text: '{"status":"executed","summary":"Renamed the project"}' }] } }],
    });
  });
});
