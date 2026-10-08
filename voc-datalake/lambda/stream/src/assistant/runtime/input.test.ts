import { describe, it, expect } from 'vitest';
import { LIMITS } from '../contract.js';
import { parseRunInput, runBody } from './__fixtures__/fakes.js';
import { isUserMessage, lastUserIndex, textOfParts } from './input.js';

const json = (value: unknown) => JSON.stringify(value);

/** The exact error a body is refused with (`toThrow(errorInstance)` does not compare the message here). */
function rejection(body: string): { name: string; message: string } {
  try {
    parseRunInput(body);
    return { name: 'accepted', message: '' };
  } catch (err) {
    return err instanceof Error ? { name: err.name, message: err.message } : { name: 'non-error', message: String(err) };
  }
}

describe('parseRunInput', () => {
  it('accepts a minimal AG-UI run input', () => {
    const { input, props } = parseRunInput(json(runBody({ forwardedProps: { page: { kind: 'home', path: '/' }, days: 30, useWebSearch: true } })));
    expect(input.threadId).toBe('thread-1');
    expect(props).toStrictEqual({ page: { kind: 'home', path: '/' }, days: 30, useWebSearch: true });
  });

  it('defaults the AG-UI tools and context arrays', () => {
    const { input } = parseRunInput(json({ threadId: 't', runId: 'r', messages: [{ id: 'u', role: 'user', content: 'hi' }], forwardedProps: { page: { kind: 'home', path: '/' } } }));
    expect(input.tools).toStrictEqual([]);
    expect(input.context).toStrictEqual([]);
  });

  it.each([
    ['invalid JSON', '{', 'not valid JSON'],
    ['missing threadId', json({ ...runBody(), threadId: undefined }), 'threadId'],
    ['unknown page kind', json(runBody({ forwardedProps: { page: { kind: 'admin-console', path: '/' } } })), 'page.kind'],
    ['days out of range', json(runBody({ forwardedProps: { page: { kind: 'home', path: '/' }, days: 10_000 } })), 'days'],
    ['negative days', json(runBody({ forwardedProps: { page: { kind: 'home', path: '/' }, days: -1 } })), 'days'],
    ['no user message', json(runBody({ messages: [{ id: 'a', role: 'assistant', content: 'hi' }] })), 'user message'],
  ])('rejects %s', (_label, body, fragment) => {
    expect(() => parseRunInput(body)).toThrow(fragment);
  });

  it('rejects too many messages', () => {
    const messages = Array.from({ length: LIMITS.maxMessages + 1 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x' }));
    expect(() => parseRunInput(json(runBody({ messages })))).toThrow(`At most ${LIMITS.maxMessages} messages`);
  });

  it('rejects an over-long NEW user message but not an over-long earlier one', () => {
    const long = 'x'.repeat(LIMITS.maxUserMessageChars + 1);
    expect(() => parseRunInput(json(runBody({ messages: [{ id: 'u', role: 'user', content: long }] })))).toThrow('exceeds');
    const history = [
      { id: 'u0', role: 'user', content: long },
      { id: 'a0', role: 'assistant', content: 'ok' },
      { id: 'u1', role: 'user', content: 'short' },
    ];
    expect(() => parseRunInput(json(runBody({ messages: history })))).not.toThrow();
  });

  it('rejects too many attachments', () => {
    const image = { type: 'image', source: { type: 'data', value: 'aGk=', mimeType: 'image/png' } };
    const content = [{ type: 'text', text: 'see' }, ...Array.from({ length: LIMITS.maxAttachments + 1 }, () => image)];
    expect(() => parseRunInput(json(runBody({ messages: [{ id: 'u', role: 'user', content }] })))).toThrow('attachments');
  });
});

describe('parse errors name the input, the path and the issue', () => {
  it.each([
    ['an empty body (read as null)', '', 'Invalid run input: Invalid input: expected object, received null'],
    ['a top-level array', '[]', 'Invalid run input: Invalid input: expected object, received array'],
    ['a bad forwardedProps field', json(runBody({ forwardedProps: { page: { kind: 'home', path: '/' }, days: 'x' } })), 'Invalid forwardedProps at days: Invalid input: expected number, received string'],
  ])('%s', (_label, body, message) => {
    expect(rejection(body)).toStrictEqual({ name: 'ValidationError', message });
  });
});

describe('enforceLimits — the bounds themselves are allowed', () => {
  const userWith = (content: unknown) => json(runBody({ messages: [{ id: 'u', role: 'user', content }] }));
  const image = (value: string) => ({ type: 'image', source: { type: 'data', value, mimeType: 'image/png' } });

  it('accepts exactly maxMessages messages', () => {
    const messages = Array.from({ length: LIMITS.maxMessages }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x' }));
    expect(parseRunInput(json(runBody({ messages }))).input.messages).toHaveLength(LIMITS.maxMessages);
  });

  it('accepts a new message of exactly maxUserMessageChars, counting text parts joined by a newline', () => {
    const half = 'x'.repeat(LIMITS.maxUserMessageChars / 2);
    expect(() => parseRunInput(userWith('x'.repeat(LIMITS.maxUserMessageChars)))).not.toThrow();
    expect(rejection(userWith([{ type: 'text', text: half }, { type: 'text', text: half }]))).toStrictEqual({
      name: 'ValidationError', message: `Message exceeds ${LIMITS.maxUserMessageChars} characters`,
    });
  });

  it('accepts exactly maxAttachments attachments', () => {
    const content = [{ type: 'text', text: 'see' }, ...Array.from({ length: LIMITS.maxAttachments }, () => image('aGk='))];
    expect(() => parseRunInput(userWith(content))).not.toThrow();
  });

  it('rejects an inline attachment over the size limit and accepts one at it', () => {
    expect(() => parseRunInput(userWith([image('a'.repeat(LIMITS.maxAttachmentBase64Chars))]))).not.toThrow();
    expect(rejection(userWith([image('a'.repeat(LIMITS.maxAttachmentBase64Chars + 1))]))).toStrictEqual({
      name: 'ValidationError', message: 'Attachment exceeds the size limit',
    });
  });

  it('does not size-check an attachment given by URL', () => {
    const url = { type: 'image', source: { type: 'url', value: `https://x.test/${'a'.repeat(LIMITS.maxAttachmentBase64Chars)}` } };
    expect(() => parseRunInput(userWith([url]))).not.toThrow();
  });

  it('rejects a run without a user message with a ValidationError', () => {
    expect(rejection(json(runBody({ messages: [] })))).toStrictEqual({ name: 'ValidationError', message: 'The run must contain a user message' });
  });
});

describe('message helpers', () => {
  it('isUserMessage is true only for a user message', () => {
    expect(isUserMessage({ id: 'u', role: 'user', content: 'a' })).toBe(true);
    expect(isUserMessage({ id: 'a', role: 'assistant', content: 'a' })).toBe(false);
    expect(isUserMessage(undefined)).toBe(false);
  });

  it('textOfParts joins the text parts with a newline and skips media', () => {
    expect(textOfParts([
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'data', value: 'aGk=', mimeType: 'image/png' } },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb');
  });
});

describe('lastUserIndex', () => {
  it('finds the newest user message', () => {
    expect(lastUserIndex([
      { id: '1', role: 'user', content: 'a' },
      { id: '2', role: 'assistant', content: 'b' },
      { id: '3', role: 'user', content: 'c' },
      { id: '4', role: 'tool', toolCallId: 't', content: 'd' },
    ])).toBe(2);
    expect(lastUserIndex([])).toBe(-1);
  });
});
