/**
 * Mutation hardening of the stored session record (record.ts).
 *
 * The run-level tests (session.test.ts) only ever stored small, well-formed
 * conversations, so Stryker found that nothing pinned: the thread-id pattern's
 * anchors, how an attachment is stripped (its mimeType fallback, the emptied
 * data source, the name fallback), how non-string content is read as text, the
 * tool-content trim, the title rules (first USER message, whitespace collapse,
 * the 60-char boundary, the 'New conversation' fallback), the 300-message turn
 * window and its fallbacks, the one-turn shrink of tool contents, the exact
 * MAX_ITEM_BYTES boundary and the null result when nothing can shrink.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '@ag-ui/core';
import { buildSessionItem, estimatedItemBytes, isStorableThreadId, MAX_ITEM_BYTES } from './record.js';

const snapshotBase = {
  callerSub: 'sub-1', threadId: 'thread-1', runId: 'run-1', status: 'running' as const,
  page: { kind: 'chat' as const, path: '/chat' }, pendingInterrupts: [], createdAt: 'c', updatedAt: 'u', revision: 3,
};

/** Wire data the types forbid but a client can still send: kept as long as it has a role. */
function loose(raw: readonly unknown[]): Message[] {
  return raw.filter((m): m is Message => typeof m === 'object' && m !== null && 'role' in m);
}

function itemOf(messages: readonly Message[]): Record<string, unknown> {
  const item = buildSessionItem({ ...snapshotBase, messages });
  if (item === null) throw new RangeError('expected an item');
  return item;
}

function storedOf(messages: readonly Message[]): unknown {
  return JSON.parse(String(itemOf(messages).messages_json));
}

function titleOf(messages: readonly Message[]): unknown {
  return itemOf(messages).title;
}

const user = (id: string, content = `q-${id}`): Message => ({ id, role: 'user', content });
const answer = (id: string, content = `a-${id}`): Message => ({ id, role: 'assistant', content });

describe('isStorableThreadId accepts only a whole 1–64 char [A-Za-z0-9_-] id', () => {
  it.each([
    ['abc_DEF-123', true],
    ['x'.repeat(64), true],
    ['x'.repeat(65), false],
    ['', false],
    ['bad/abc', false],
    ['abc/bad', false],
  ])('%s → %s', (id, expected) => {
    expect(isStorableThreadId(id)).toBe(expected);
  });
});

describe('the stored item carries every attribute the chat handler serves', () => {
  it('writes the exact item for a one-message conversation', () => {
    expect(itemOf([user('u1', 'hello')])).toStrictEqual({
      pk: 'USER#sub-1', sk: 'CONV#thread-1', conversation_id: 'thread-1', kind: 'assistant', title: 'hello',
      messages_json: '[{"id":"u1","role":"user","content":"hello"}]', page_json: '{"kind":"chat","path":"/chat"}',
      pending_json: '[]', message_count: 1, created_at: 'c', updated_at: 'u', run_id: 'run-1', run_status: 'running', revision: 3,
    });
  });
});

describe('attachments are stored without their data', () => {
  it('keeps text parts as they are and empties every media source', () => {
    const message: Message = {
      id: 'u1', role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' }, metadata: { name: 'shot.png' } },
        { type: 'image', source: { type: 'url', value: 'https://example.com/x' } },
        { type: 'document', source: { type: 'data', value: 'BBBB', mimeType: 'application/pdf' }, metadata: { name: 7 } },
      ],
    };
    expect(storedOf([message])).toStrictEqual([{
      id: 'u1', role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'data', value: '', mimeType: 'image/png' }, metadata: { name: 'shot.png', mimeType: 'image/png' } },
        { type: 'image', source: { type: 'data', value: '', mimeType: 'application/octet-stream' }, metadata: { name: 'image', mimeType: 'application/octet-stream' } },
        { type: 'document', source: { type: 'data', value: '', mimeType: 'application/pdf' }, metadata: { name: 'document', mimeType: 'application/pdf' } },
      ],
    }]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'shot.png'],
  ])('names the part by its type when metadata is %s', (_label, metadata) => {
    const [message] = loose([{ id: 'u1', role: 'user', content: [{ type: 'image', source: { type: 'data', value: 'A', mimeType: 'image/gif' }, metadata }] }]);
    expect(storedOf(message ? [message] : [])).toStrictEqual([{
      id: 'u1', role: 'user',
      content: [{ type: 'image', source: { type: 'data', value: '', mimeType: 'image/gif' }, metadata: { name: 'image', mimeType: 'image/gif' } }],
    }]);
  });

  it('leaves an assistant message without content untouched', () => {
    const toolOnly: Message = { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
    expect(storedOf([user('u1'), toolOnly])).toStrictEqual([
      { id: 'u1', role: 'user', content: 'q-u1' },
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ]);
  });
});

describe('tool contents are stored as trimmed text', () => {
  it('trims a tool result to exactly 4,000 characters', () => {
    const tool: Message = { id: 't1', role: 'tool', toolCallId: 'c1', content: 'y'.repeat(4001) };
    expect(storedOf([tool])).toStrictEqual([{ id: 't1', role: 'tool', toolCallId: 'c1', content: 'y'.repeat(4000) }]);
  });

  it('joins the string text of array parts and skips everything else', () => {
    const messages = loose([
      { id: 't1', role: 'tool', toolCallId: 'c1', content: ['raw', null, { text: 5 }, { type: 'text', text: 'Hel' }, { text: 'lo' }] },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: 42 },
    ]);
    expect(storedOf(messages)).toStrictEqual([
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'Hello' },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: '' },
    ]);
  });
});

describe('the title is the first user message', () => {
  it('skips earlier assistant messages', () => {
    expect(titleOf([answer('a0', 'Welcome back'), user('u1', 'Why late?')])).toBe('Why late?');
  });

  it('collapses whitespace runs and trims', () => {
    expect(titleOf([user('u1', '  late \n\n  deliveries  ')])).toBe('late deliveries');
  });

  it('reads the text parts of a multi-part user message', () => {
    const message: Message = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'text', text: ' here' }] };
    expect(titleOf([message])).toBe('Look here');
  });

  it('keeps 60 characters whole and cuts 61 to 59 plus an ellipsis', () => {
    expect(titleOf([user('u1', 'a'.repeat(60))])).toBe('a'.repeat(60));
    expect(titleOf([user('u1', 'b'.repeat(61))])).toBe(`${'b'.repeat(59)}…`);
  });

  it('falls back to New conversation without a user message', () => {
    expect(titleOf([answer('a1', 'Hi')])).toBe('New conversation');
  });
});

describe('the list keeps the newest whole turns within 300 messages', () => {
  const idsOf = (messages: readonly Message[]): unknown => {
    const stored = storedOf(messages);
    return Array.isArray(stored) ? stored.map((m: unknown) => (typeof m === 'object' && m !== null ? Reflect.get(m, 'id') : null)) : null;
  };
  const answers = (from: number, count: number): Message[] => Array.from({ length: count }, (_, n) => answer(`a${from + n}`));

  it('keeps exactly 300 messages, even when the first is not a user message', () => {
    const messages = [...answers(0, 1), user('u1'), ...answers(2, 298)];
    expect(itemOf(messages).message_count).toBe(300);
    expect(idsOf(messages)).toStrictEqual(messages.map((m) => m.id));
  });

  it('drops the oldest turn when one more message would exceed 300', () => {
    const messages = [user('u0'), answer('a0'), user('u1'), ...answers(1, 297), user('u2'), answer('a298')];
    expect(itemOf(messages).message_count).toBe(300);
    expect(idsOf(messages)).toStrictEqual(messages.slice(2).map((m) => m.id));
  });

  it('keeps the newest turn whole when no turn fits', () => {
    const messages = [user('u0'), user('u1'), user('u2'), ...answers(0, 300)];
    expect(itemOf(messages).message_count).toBe(301);
    expect(idsOf(messages)).toStrictEqual(messages.slice(2).map((m) => m.id));
  });
});

describe('the size cap', () => {
  const withAnswer = (chars: number): Message[] => [user('u1', 'q'), answer('a1', 'x'.repeat(chars))];

  it('keeps an item of exactly MAX_ITEM_BYTES and refuses one byte more when nothing can shrink', () => {
    const overhead = estimatedItemBytes(itemOf(withAnswer(0)));
    const exact = withAnswer(MAX_ITEM_BYTES - overhead);
    expect(estimatedItemBytes(itemOf(exact))).toBe(MAX_ITEM_BYTES);
    expect(buildSessionItem({ ...snapshotBase, messages: withAnswer(MAX_ITEM_BYTES - overhead + 1) })).toBeNull();
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(estimatedItemBytes({ a: 'é€' })).toBe(13);
  });

  it('shrinks the tool contents of a one-turn record to 1,000 characters each', () => {
    const tools: Message[] = Array.from({ length: 90 }, (_, n) => ({ id: `t${n}`, role: 'tool', toolCallId: `c${n}`, content: 'y'.repeat(5000) }));
    const stored = storedOf([user('u1'), ...tools]);
    expect(stored).toStrictEqual([
      { id: 'u1', role: 'user', content: 'q-u1' },
      ...tools.map((t) => ({ ...t, content: 'y'.repeat(1000) })),
    ]);
  });

  it('gives up (null) when the only tool content is already 1,000 characters', () => {
    const tool: Message = { id: 't1', role: 'tool', toolCallId: 'c1', content: 'y'.repeat(1000) };
    expect(buildSessionItem({ ...snapshotBase, messages: [user('u1'), tool, answer('a1', 'x'.repeat(MAX_ITEM_BYTES))] })).toBeNull();
  });
});
