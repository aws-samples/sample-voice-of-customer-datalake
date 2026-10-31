import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { APP_CLIENT_IDS_ENV, requireAppClient } from './app-client.js';
import { extractCallerClaims, getBodyText, isAdminCaller, parseGroups, parseLambdaEvent } from './event.js';

function eventWithClaims(claims: Record<string, unknown>) {
  return parseLambdaEvent({ body: '{}', requestContext: { authorizer: { claims } } });
}

describe('extractCallerClaims', () => {
  beforeEach(() => { vi.stubEnv(APP_CLIENT_IDS_ENV, 'client,board-client'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refuses a token of another app client of the pool (an MCP OAuth client) with a 401', () => {
    for (const token of [{ token_use: 'id', aud: 'kiro-client' }, { token_use: 'access', client_id: 'kiro-client' }]) {
      expect(() => extractCallerClaims(eventWithClaims({ sub: 'abc', 'cognito:groups': '[admins]', ...token })))
        .toThrow(expect.objectContaining({ statusCode: 401, message: 'This sign-in is not valid for this API' }));
    }
  });

  it('accepts the SPA web client and the board client, as ID or access token', () => {
    for (const token of [{ token_use: 'id', aud: 'client' }, { token_use: 'access', client_id: 'board-client' }]) {
      expect(extractCallerClaims(eventWithClaims({ sub: 'abc', ...token })).sub).toBe('abc');
    }
  });

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

describe('requireAppClient', () => {
  const env = { [APP_CLIENT_IDS_ENV]: ' web , board ' };

  it.each([
    [{ token_use: 'id' }],
    [{ token_use: 'access', client_id: '' }],
    [{ aud: ['web'] }],
  ])('refuses a token without a usable issuing client: %j', (claims) => {
    expect(() => requireAppClient(claims, env)).toThrow('not valid for this API');
  });

  it('refuses every token while APP_CLIENT_IDS is unset (fails closed)', () => {
    expect(() => requireAppClient({ token_use: 'id', aud: 'web' }, {})).toThrow('not valid for this API');
  });

  it('prefers client_id over a resource audience', () => {
    expect(() => requireAppClient({ token_use: 'access', client_id: 'web', aud: 'https://api.example/mcp' }, env)).not.toThrow();
  });

  it('does not judge claims our own Lambdas forward (no token markers)', () => {
    expect(() => requireAppClient({ sub: 's', 'cognito:groups': 'admins' }, {})).not.toThrow();
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
