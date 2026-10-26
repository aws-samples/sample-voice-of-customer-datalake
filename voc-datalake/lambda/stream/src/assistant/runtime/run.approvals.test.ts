/**
 * Write approvals (interrupts), resume, identity and RUN_ERROR paths of the
 * assistant runtime.
 */
import { describe, it, expect } from 'vitest';
import { bedrockEvents, failingStream, fakeToolset, runBody } from './__fixtures__/fakes.js';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import {
  createProject,
  finished,
  harness,
  lastUserContent,
  run,
  searchTool,
  silenceConsole,
  types,
  updateDocument,
} from './__fixtures__/harness.js';
import { encodeReasoning } from './reasoning.js';
import { nth } from '../../lib/nth-fixtures.js';
import { ABANDONED_RESULT, DECLINED_RESULT } from './tail.js';

class ValidationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationException';
  }
}

const EXECUTED = JSON.stringify({ status: 'executed', summary: 'Project created' });

function resumeBody(options: {
  toolMessage?: string;
  resumeStatus?: 'resolved' | 'cancelled';
  approved?: boolean;
  toolName?: string;
  encryptedValue?: string;
  toolCallId?: string;
}) {
  const id = options.toolCallId ?? 'tu_1';
  return runBody({
    runId: 'run-2',
    messages: [
      { id: 'u1', role: 'user', content: 'Make a project for the delivery issue' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'I will create it.',
        ...(options.encryptedValue ? { encryptedValue: options.encryptedValue } : {}),
        toolCalls: [{
          id,
          type: 'function',
          function: { name: options.toolName ?? 'create_project', arguments: '{"name":"Delivery"}' },
        }],
      },
      ...(options.toolMessage === undefined ? [] : [{ id: 't1', role: 'tool', toolCallId: id, content: options.toolMessage }]),
    ],
    resume: [{
      interruptId: `approval:${id}`,
      status: options.resumeStatus ?? 'resolved',
      payload: { approved: options.approved ?? true },
    }],
  });
}

silenceConsole();

describe('client tools → interrupt', () => {
  const mixedTurn = () => harness([{
    text: 'Creating it.',
    toolUses: [
      { id: 'tu_s', name: 'search_feedback', input: {} },
      { id: 'tu_c', name: 'create_project', input: { name: '  Delivery fixes ' } },
    ],
  }]);

  it('ends the run on a client tool and does not call Bedrock again', async () => {
    const h = mixedTurn();
    const events = await run(runBody(), h);

    expect(h.calls).toHaveLength(1);
    expect(types(events).slice(-2)).toStrictEqual(['CUSTOM:assistant.sources', 'RUN_FINISHED']);
    expect(events.filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => e.toolCallId)).toStrictEqual(['tu_s']);
    expect(events.filter((e) => e.type === 'TOOL_CALL_ARGS').at(-1)).toMatchObject({ toolCallId: 'tu_c', delta: '{"name":"Delivery fixes"}' });
  });

  it('finishes with a tool_approval interrupt for the client tool', async () => {
    const events = await run(runBody(), mixedTurn());

    expect(finished(events).outcome).toStrictEqual({
      type: 'interrupt',
      interrupts: [{
        id: 'approval:tu_c',
        reason: 'tool_approval',
        toolCallId: 'tu_c',
        message: 'Do create_project with name',
        expiresAt: '2026-03-01T12:30:00.000Z',
        metadata: { toolName: 'create_project', risk: 'write' },
      }],
    });
  });

  it('puts the project id into the interrupt metadata', async () => {
    const h = harness([{ toolUses: [{ id: 'tu_d', name: 'update_document', input: {} }] }]);
    const events = await run(runBody(), h);
    expect(finished(events).outcome).toMatchObject({
      interrupts: [{ metadata: { toolName: 'update_document', risk: 'write', projectId: 'p1' } }],
    });
  });

  it('returns invalid client args to the model as an error, without an interrupt', async () => {
    const h = harness([{ toolUses: [{ id: 'tu_c', name: 'create_project', input: {} }] }, { text: 'What name?' }]);
    const events = await run(runBody(), h);

    expect(h.calls).toHaveLength(2);
    expect(lastUserContent(nth(h.calls, 1))).toStrictEqual([{
      toolResult: { toolUseId: 'tu_c', content: [{ text: 'Error: invalid arguments — name is required' }], status: 'error' },
    }]);
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('round-trips the turn reasoning as REASONING_ENCRYPTED_VALUE', async () => {
    const h = harness([{ reasoning: 'plan', signature: 'sig-1', toolUses: [{ id: 'tu_c', name: 'create_project', input: { name: 'A' } }] }]);
    const events = await run(runBody(), h);
    const encrypted = events.find((e) => e.type === 'REASONING_ENCRYPTED_VALUE');
    const start = events.find((e) => e.type === 'TOOL_CALL_START');
    expect(encrypted).toMatchObject({ subtype: 'message', entityId: start?.parentMessageId });
  });
});

describe('resume after approval', () => {
  it('sends the executed outcome to Bedrock as the toolResult of the original call', async () => {
    const h = harness([{ text: 'Done — the project exists now.' }]);
    await run(resumeBody({ toolMessage: EXECUTED }), h);

    const call = nth(h.calls, 0);
    expect(call.messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'user']);
    expect(nth(call.messages, 1).content).toStrictEqual([
      { text: 'I will create it.' },
      { toolUse: { toolUseId: 'tu_1', name: 'create_project', input: { name: 'Delivery' } } },
    ]);
    expect(lastUserContent(call)).toStrictEqual([{ toolResult: { toolUseId: 'tu_1', content: [{ text: EXECUTED }] } }]);
  });

  it('keeps the resumed tool in the toolset and finishes the resumed run', async () => {
    const h = harness([{ text: 'Done — the project exists now.' }]);
    const events = await run(resumeBody({ toolMessage: EXECUTED }), h);

    expect(nth(h.toolsetOptions, 0).alsoInclude).toStrictEqual(['create_project']);
    expect(finished(events)).toMatchObject({ runId: 'run-2', outcome: { type: 'success' } });
  });

  it('passes a declined outcome through verbatim', async () => {
    const declined = JSON.stringify({ status: 'declined', reason: 'not now' });
    const h = harness([{ text: 'OK, I will not create it.' }]);
    await run(resumeBody({ toolMessage: declined, resumeStatus: 'cancelled', approved: false }), h);
    expect(lastUserContent(nth(h.calls, 0))).toStrictEqual([{ toolResult: { toolUseId: 'tu_1', content: [{ text: declined }] } }]);
  });

  it('synthesises a declined result from a cancelled resume entry without a tool message', async () => {
    const h = harness([{ text: 'ok' }]);
    await run(resumeBody({ resumeStatus: 'cancelled', approved: false }), h);
    expect(lastUserContent(nth(h.calls, 0))).toStrictEqual([{ toolResult: { toolUseId: 'tu_1', content: [{ text: DECLINED_RESULT }] } }]);
  });

  it('synthesises an abandoned error result for an approved call that never reported back', async () => {
    const h = harness([{ text: 'ok' }]);
    await run(resumeBody({}), h);
    expect(lastUserContent(nth(h.calls, 0))).toStrictEqual([{
      toolResult: { toolUseId: 'tu_1', content: [{ text: ABANDONED_RESULT }], status: 'error' },
    }]);
  });

  it('replays the stored thinking block before the tool call', async () => {
    const encryptedValue = encodeReasoning([{ reasoningContent: { reasoningText: { text: 'plan', signature: 'sig-1' } } }]);
    const h = harness([{ text: 'ok' }]);
    await run(resumeBody({ toolMessage: EXECUTED, encryptedValue }), h);
    expect(nth(nth(h.calls, 0).messages, 1).content?.[0]).toStrictEqual({
      reasoningContent: { reasoningText: { text: 'plan', signature: 'sig-1' } },
    });
  });

  it('retries once with a text tail when Bedrock rejects the structured tail', async () => {
    const h = harness([{ text: 'Recovered.' }]);
    const original = h.deps.converse;
    const attempts = { count: 0 };
    h.deps.converse = (params) => {
      attempts.count += 1;
      if (attempts.count === 1) {
        return failingStream(new ValidationException('Expected thinking block'));
      }
      return original(params);
    };
    const events = await run(resumeBody({ toolMessage: EXECUTED }), h);

    expect(attempts.count).toBe(2);
    expect(JSON.stringify(nth(h.calls, 0).messages)).not.toContain('toolUse');
    expect(JSON.stringify(lastUserContent(nth(h.calls, 0)))).toContain('Project created');
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('does not fall back (no duplicate TEXT_MESSAGE_START) when the rejection surfaces after deltas streamed', async () => {
    const h = harness([{ text: 'Recovered.' }]);
    const original = h.deps.converse;
    const attempts = { count: 0 };
    async function* partialThenFail(): AsyncGenerator<ConverseStreamOutput> {
      yield* bedrockEvents({ text: 'Partial' }).filter((e) => e.contentBlockDelta !== undefined);
      throw new ValidationException('Expected thinking block');
    }
    h.deps.converse = (params) => {
      attempts.count += 1;
      return attempts.count === 1 ? partialThenFail() : original(params);
    };
    const events = await run(resumeBody({ toolMessage: EXECUTED }), h);
    expect(attempts.count).toBe(1);
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_START')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
  });

  it('renders the tail as text when the referenced tool is not in the toolset', async () => {
    const h = harness([{ text: 'ok' }], fakeToolset([searchTool]));
    await run(resumeBody({ toolMessage: EXECUTED }), h);
    expect(JSON.stringify(nth(h.calls, 0).messages)).not.toContain('toolUse');
    expect(nth(h.calls, 0).messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'user']);
  });

  it('flattens earlier turns and caches the end of the flattened history', async () => {
    const h = harness([{ text: 'ok' }], fakeToolset([searchTool, createProject, updateDocument]));
    await run(runBody({
      messages: [
        { id: 'u0', role: 'user', content: 'first' },
        { id: 'a0', role: 'assistant', content: 'answer', toolCalls: [{ id: 'old', type: 'function', function: { name: 'search_feedback', arguments: '{}' } }] },
        { id: 't0', role: 'tool', toolCallId: 'old', content: 'old result' },
        { id: 'u1', role: 'user', content: 'second' },
      ],
    }), h);
    expect(nth(h.calls, 0).messages).toStrictEqual([
      { role: 'user', content: [{ text: 'first' }] },
      { role: 'assistant', content: [{ text: 'answer\n[tool search_feedback({}) → old result]' }] },
      { role: 'user', content: [{ text: 'second' }] },
    ]);
    expect(nth(h.calls, 0).cacheMessageIndex).toBe(1);
  });
});

describe('identity and errors', () => {
  it('fails closed without a subject claim', async () => {
    const h = harness([{ text: 'x' }]);
    const events = await run(runBody(), h, null);
    expect(types(events)).toStrictEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(events[1]).toMatchObject({ code: 'unauthorized' });
    expect(h.calls).toHaveLength(0);
  });

  it('treats the admins group as admin', async () => {
    const h = harness([{ text: 'x' }]);
    await run(runBody(), h, { sub: 's', 'cognito:groups': '[users admins]' });
    expect(h.toolsetOptions[0]).toMatchObject({ isAdmin: true });
  });

  it('rejects a body that is not an AG-UI run input', async () => {
    const h = harness([]);
    const events = await run('{not json', h);
    expect(events).toStrictEqual([expect.objectContaining({ type: 'RUN_ERROR', code: 'invalid_request' })]);
  });

  it('rejects a run without forwardedProps.page', async () => {
    const h = harness([]);
    const events = await run(runBody({ forwardedProps: {} }), h);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'invalid_request' });
    expect(String(events.at(-1)?.message)).toContain('page');
  });

  it('hides internal error text behind a generic service_error', async () => {
    const h = harness([]);
    h.deps.converse = () => failingStream(new TypeError('secret internal detail at handler.ts:42'));
    const events = await run(runBody(), h);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'service_error' });
    expect(JSON.stringify(events)).not.toContain('secret internal detail');
  });

  it('maps Bedrock throttling to a retryable code', async () => {
    const h = harness([]);
    h.deps.converse = () => failingStream(Object.assign(new TypeError('Too many requests'), { name: 'ThrottlingException' }));
    const events = await run(runBody(), h);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'throttled' });
  });
});
