/**
 * list_users and get_user_access: admin-only reads of the Users API as the
 * caller (claims forwarded). The directory reaches the model projected — no
 * `sub`, no flags, strings clipped, at most 500 users — and a non-admin is
 * refused before any invoke.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { MAX_LISTED_USERS } from './users.js';

const UUID = '5f1c2a6e-0000-4000-8000-000000000001';
const admin = fakeContext('settings', {}, { isAdmin: true, claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } });

/** One listed user as the route answers it: `sub`, `flags` and `last_modified` must not pass. */
const JANE = {
  username: UUID,
  sub: 'sub-jane',
  email: 'jane@example.com',
  name: 'Jane Doe',
  given_name: 'Jane',
  family_name: 'Doe',
  status: 'CONFIRMED',
  enabled: false,
  groups: ['users'],
  created_at: '2026-01-01T00:00:00+00:00',
  last_modified: '2026-02-01T00:00:00+00:00',
  flags: { fallback_owner: false, memory_reviewer: true },
};
const PROJECTED_JANE = {
  username: UUID,
  email: 'jane@example.com',
  name: 'Jane Doe',
  given_name: 'Jane',
  family_name: 'Doe',
  groups: ['users'],
  status: 'CONFIRMED',
  enabled: false,
  created_at: '2026-01-01T00:00:00+00:00',
};
const ACCESS_PATH = `/users/${UUID}/category-access`;
const ACCESS_ANSWER = {
  success: true, username: UUID, all: false, categories: ['billing'], sources: null, owned_categories: ['delivery'], updated_at: '2026-03-01T00:00:00+00:00',
};

const usersRoute = (users: unknown[]) => ({ 'GET /users': { success: true, users } });

async function listUsers(users: unknown[], ctx = admin) {
  const deps = fakeDeps(usersRoute(users));
  const result = await serverTool(deps, 'list_users').execute({}, ctx);
  return { deps, body: JSON.parse(result.content) };
}

describe('list_users', () => {
  it('GETs /users as the caller', async () => {
    const { deps } = await listUsers([JANE]);
    expect(deps.calls).toStrictEqual([{ call: { fn: 'users', method: 'GET', path: '/users', resource: '/users' }, sub: 'admin-sub' }]);
  });

  it('projects each user to the allowlisted fields — never sub, flags or last_modified', async () => {
    const { body } = await listUsers([JANE, { username: 'u2', email: '', created_at: null, groups: [] }, 'not a record']);
    expect(body).toStrictEqual({ count: 2, users: [PROJECTED_JANE, { username: 'u2', groups: [] }] });
    expect(JSON.stringify(body)).not.toContain('sub-jane');
  });

  it('clips long strings to 200 characters', async () => {
    const { body } = await listUsers([{ ...JANE, name: 'x'.repeat(250) }]);
    expect(body.users[0].name).toBe(`${'x'.repeat(200)}…`);
  });

  it(`returns at most ${MAX_LISTED_USERS} users and says when the directory was cut`, async () => {
    const directory = Array.from({ length: MAX_LISTED_USERS + 1 }, (_, i) => ({ username: `u${i}`, email: `u${i}@example.com` }));
    const { body } = await listUsers(directory);
    expect(body.users).toHaveLength(MAX_LISTED_USERS);
    expect(body).toMatchObject({ count: MAX_LISTED_USERS + 1, truncated: true });
    expect((await listUsers(directory.slice(0, MAX_LISTED_USERS))).body).not.toHaveProperty('truncated');
  });

  it('cuts a directory of long rows at a row boundary, flagged, so the result is still valid JSON', async () => {
    const { body } = await listUsers(Array.from({ length: 300 }, (_, i) => ({ ...JANE, username: `${UUID.slice(0, 33)}${String(i).padStart(3, '0')}` })));
    expect(body).toMatchObject({ count: 300, truncated: true });
    expect(body.users.length).toBeGreaterThan(200);
    expect(body.users.length).toBeLessThan(300);
    expect(body.users.at(-1)).toMatchObject({ email: 'jane@example.com', created_at: JANE.created_at });
  });

  it('refuses a non-admin before any invoke', async () => {
    const deps = fakeDeps(usersRoute([JANE]));
    await expect(serverTool(deps, 'list_users').execute({}, fakeContext('settings'))).rejects.toMatchObject({
      code: 'not_permitted', message: 'list_users is only available to administrators.',
    });
    expect(deps.calls).toStrictEqual([]);
  });

  it('refuses any argument', async () => {
    await expect(serverTool(fakeDeps(usersRoute([])), 'list_users').execute({ limit: 10 }, admin)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('get_user_access', () => {
  it('GETs /users/{username}/category-access through the proxy resource as the caller', async () => {
    const deps = fakeDeps({ [`GET ${ACCESS_PATH}`]: ACCESS_ANSWER });
    await serverTool(deps, 'get_user_access').execute({ username: UUID }, admin);
    expect(deps.calls).toStrictEqual([{
      call: { fn: 'users', method: 'GET', path: ACCESS_PATH, resource: '/users/{proxy+}', pathParameters: { proxy: `${UUID}/category-access` } },
      sub: 'admin-sub',
    }]);
  });

  it('returns username, all, categories, sources (null kept: the default rule) and owned_categories only', async () => {
    const result = await serverTool(fakeDeps({ [`GET ${ACCESS_PATH}`]: ACCESS_ANSWER }), 'get_user_access').execute({ username: UUID }, admin);
    expect(JSON.parse(result.content)).toStrictEqual({ username: UUID, all: false, categories: ['billing'], sources: null, owned_categories: ['delivery'] });
  });

  it('keeps an explicit source grant, and reads a malformed answer as nothing granted', async () => {
    const granted = { ...ACCESS_ANSWER, all: true, categories: ['*'], sources: ['webscraper'] };
    const read = async (answer: unknown) => JSON.parse((await serverTool(fakeDeps({ [`GET ${ACCESS_PATH}`]: answer }), 'get_user_access')
      .execute({ username: UUID }, admin)).content);
    expect(await read(granted)).toStrictEqual({ username: UUID, all: true, categories: ['*'], sources: ['webscraper'], owned_categories: ['delivery'] });
    expect(await read('<html>')).toStrictEqual({ username: UUID, all: false, categories: [], sources: null, owned_categories: [] });
  });

  it('encodes the path segment but not the proxy parameter', async () => {
    const alias = 'jane+voc@example.com';
    const deps = fakeDeps({ [`GET /users/${encodeURIComponent(alias)}/category-access`]: ACCESS_ANSWER });
    await serverTool(deps, 'get_user_access').execute({ username: alias }, admin);
    expect(deps.calls[0]?.call).toMatchObject({ path: '/users/jane%2Bvoc%40example.com/category-access', pathParameters: { proxy: `${alias}/category-access` } });
  });

  it('refuses a non-admin before any invoke', async () => {
    const deps = fakeDeps({ [`GET ${ACCESS_PATH}`]: ACCESS_ANSWER });
    await expect(serverTool(deps, 'get_user_access').execute({ username: UUID }, fakeContext('settings'))).rejects.toMatchObject({
      code: 'not_permitted', message: 'get_user_access is only available to administrators.',
    });
    expect(deps.calls).toStrictEqual([]);
  });

  it.each([{}, { username: 'a/b' }, { username: '' }, { username: UUID, extra: 1 }])('refuses %o before any invoke', async (input) => {
    const deps = fakeDeps({ [`GET ${ACCESS_PATH}`]: ACCESS_ANSWER });
    await expect(serverTool(deps, 'get_user_access').execute(input, admin)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });
});
