import { describe, it, expect } from 'vitest';
import type { Message, UserMessage } from '@ag-ui/core';
import { LIMITS } from '../contract.js';
import { nth } from '../../lib/nth-fixtures.js';
import { ABANDONED_RESULT, buildTail, inspectTail } from './tail.js';

const user: UserMessage = { id: 'u', role: 'user', content: 'go' };

const call = (id: string, name = 'search_feedback', args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } });

describe('buildTail (structured)', () => {
  it('pairs every toolUse with a toolResult in the next user message', () => {
    const after: Message[] = [
      { id: 'a1', role: 'assistant', content: 'one', toolCalls: [call('t1'), call('t2')] },
      { id: 'r2', role: 'tool', toolCallId: 't2', content: 'second' },
      { id: 'r1', role: 'tool', toolCallId: 't1', content: 'first' },
      { id: 'a2', role: 'assistant', toolCalls: [call('t3')] },
    ];
    const { messages } = buildTail(user, after, [], 'structured');
    expect(messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(nth(messages, 2).content?.map((b) => b.toolResult?.toolUseId)).toStrictEqual(['t1', 't2']);
    expect(nth(messages, 4).content).toStrictEqual([
      { toolResult: { toolUseId: 't3', content: [{ text: ABANDONED_RESULT }], status: 'error' } },
    ]);
  });

  it('marks a failed approval outcome as an error toolResult and keeps a declined one non-error', () => {
    const failed = JSON.stringify({ status: 'failed', error: "You don't have permission to do this." });
    const declined = JSON.stringify({ status: 'declined', reason: 'not now' });
    const after: Message[] = [
      { id: 'a1', role: 'assistant', toolCalls: [call('t1', 'create_project'), call('t2', 'delete_document')] },
      { id: 'r1', role: 'tool', toolCallId: 't1', content: failed },
      { id: 'r2', role: 'tool', toolCallId: 't2', content: declined },
    ];
    const { messages } = buildTail(user, after, [], 'structured');
    expect(nth(messages, 2).content).toStrictEqual([
      { toolResult: { toolUseId: 't1', content: [{ text: failed }], status: 'error' } },
      { toolResult: { toolUseId: 't2', content: [{ text: declined }] } },
    ]);
  });

  it('merges a text-only assistant message into the following tool turn', () => {
    const after: Message[] = [
      { id: 'a1', role: 'assistant', content: 'thinking out loud' },
      { id: 'a2', role: 'assistant', content: 'calling', toolCalls: [call('t1')] },
      { id: 'r1', role: 'tool', toolCallId: 't1', content: 'ok' },
    ];
    const { messages } = buildTail(user, after, [], 'structured');
    expect(messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'user']);
    expect(nth(messages, 1).content?.[0]).toStrictEqual({ text: 'thinking out loud\n\ncalling' });
  });

  it('drops a trailing assistant answer without tool calls', () => {
    const { messages } = buildTail(user, [{ id: 'a', role: 'assistant', content: 'partial' }], [], 'structured');
    expect(messages).toStrictEqual([{ role: 'user', content: [{ text: 'go' }] }]);
  });

  it('ignores tool messages that answer no call in the tail', () => {
    const { messages } = buildTail(user, [{ id: 'r', role: 'tool', toolCallId: 'ghost', content: 'x' }], [], 'structured');
    expect(messages).toHaveLength(1);
  });

  it('clamps an oversized tool message', () => {
    const after: Message[] = [
      { id: 'a', role: 'assistant', toolCalls: [call('t1')] },
      { id: 'r', role: 'tool', toolCallId: 't1', content: 'x'.repeat(LIMITS.maxToolMessageChars + 500) },
    ];
    const toolTurn = nth(buildTail(user, after, [], 'structured').messages, 2);
    const text = toolTurn.content?.at(0)?.toolResult?.content?.at(0)?.text ?? '';
    expect(text).toHaveLength(LIMITS.maxToolMessageChars);
    expect(text.endsWith('[... truncated]')).toBe(true);
  });

  it('converts inline attachments of the new user message', () => {
    const withImage: UserMessage = {
      id: 'u', role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'data', value: 'aGk=', mimeType: 'image/png' } }],
    };
    const first = nth(buildTail(withImage, [], [], 'structured').messages, 0);
    expect(first.content?.at(0)).toStrictEqual({ text: 'see' });
    expect(first.content?.at(1)?.image?.format).toBe('png');
  });

  it('rejects an empty user message', () => {
    expect(() => buildTail({ id: 'u', role: 'user', content: '  ' }, [], [], 'structured')).toThrow('empty');
  });
});

describe('buildTail (text)', () => {
  it('renders calls and results as plain alternating text', () => {
    const after: Message[] = [
      { id: 'a', role: 'assistant', content: 'doing it', toolCalls: [call('t1', 'create_project', '{"name":"A"}')] },
      { id: 'r', role: 'tool', toolCallId: 't1', content: '{"status":"executed"}' },
    ];
    const { messages, hasToolCalls } = buildTail(user, after, [], 'text');
    expect(hasToolCalls).toBe(true);
    expect(nth(messages, 1).content).toStrictEqual([{ text: 'doing it\n[tool create_project({"name":"A"}) id=t1]' }]);
    expect(nth(messages, 2).content).toStrictEqual([{ text: 'Tool results:\nResult of create_project (id=t1): {"status":"executed"}' }]);
  });
});

describe('inspectTail', () => {
  it('lists distinct tool names and validates ids', () => {
    expect(inspectTail([
      { id: 'a', role: 'assistant', toolCalls: [call('t1', 'x'), call('t2', 'x'), call('t3', 'y')] },
    ])).toStrictEqual({ toolNames: ['x', 'y'], idsValid: true });
    expect(inspectTail([{ id: 'a', role: 'assistant', toolCalls: [call('bad id!')] }]).idsValid).toBe(false);
  });
});
