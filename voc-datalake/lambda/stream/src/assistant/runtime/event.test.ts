import { describe, it, expect } from 'vitest';
import { extractCallerClaims, getBodyText, isAdminCaller, parseGroups, parseLambdaEvent } from './event.js';

function eventWithClaims(claims: Record<string, unknown>) {
  return parseLambdaEvent({ body: '{}', requestContext: { authorizer: { claims } } });
}

describe('extractCallerClaims', () => {
  it('forwards only sub, groups, username and email', () => {
    const claims = extractCallerClaims(eventWithClaims({
      sub: 'abc', 'cognito:groups': 'admins', 'cognito:username': 'jane', email: 'j@example.com', 'custom:x': 'y', aud: 'client',
    }));
    expect(claims).toStrictEqual({ sub: 'abc', 'cognito:groups': 'admins', 'cognito:username': 'jane', email: 'j@example.com' });
  });

  it('fails closed when sub is missing or blank', () => {
    expect(() => extractCallerClaims(eventWithClaims({ email: 'x' }))).toThrow('identity is required');
    expect(() => extractCallerClaims(eventWithClaims({ sub: '  ' }))).toThrow('identity is required');
    expect(() => extractCallerClaims(parseLambdaEvent({}))).toThrow('identity is required');
  });

  it('ignores non-string claim values', () => {
    expect(extractCallerClaims(eventWithClaims({ sub: 's', email: 42 }))).toStrictEqual({ sub: 's' });
  });
});

describe('parseGroups / isAdminCaller', () => {
  it.each([
    ['[admins users]', ['admins', 'users']],
    ['admins,users', ['admins', 'users']],
    ['[admins]', ['admins']],
    ['[admins][users]', ['admins', 'users']],
    [' admins ,  users\t', ['admins', 'users']],
    ['', []],
  ])('parses %j', (raw, expected) => {
    expect(parseGroups(raw)).toStrictEqual(expected);
  });

  it('is admin only for the exact admins group', () => {
    expect(isAdminCaller({ sub: 's', 'cognito:groups': '[users admins]' })).toBe(true);
    expect(isAdminCaller({ sub: 's', 'cognito:groups': 'superadmins' })).toBe(false);
    expect(isAdminCaller({ sub: 's' })).toBe(false);
  });
});

describe('event helpers', () => {
  it('decodes a base64 body', () => {
    const body = Buffer.from('{"a":1}').toString('base64');
    expect(getBodyText(parseLambdaEvent({ body, isBase64Encoded: true }))).toBe('{"a":1}');
  });

  it('reads a missing body as empty text', () => {
    expect(getBodyText(parseLambdaEvent({}))).toBe('');
  });

  it('treats an unparseable event as empty', () => {
    expect(parseLambdaEvent('nope')).toStrictEqual({});
  });

  it.each([
    ['a non-string body', { body: 123 }],
    ['a non-object authorizer', { requestContext: { authorizer: 'x' } }],
    ['non-record claims', { requestContext: { authorizer: { claims: 'sub=s' } } }],
  ])('treats an event with %s as empty', (_label, raw) => {
    expect(parseLambdaEvent(raw)).toStrictEqual({});
  });
});
