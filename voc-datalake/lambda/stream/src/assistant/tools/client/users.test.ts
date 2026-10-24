/**
 * User-administration write tools (create_user, update_user, set_user_access):
 * argument bounds (mirroring users_handler / category_access / category_config),
 * admin gating, summaries, and the prechecks that read GET /users (and the
 * settings routes) as the caller before an approval card is raised.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_SERVER_TOOLS } from '../../contract.js';
import { buildCatalogue } from '../catalogue.js';
import { selectToolset } from '../registry.js';
import { clientToolLookup, fakeContext, fakeDeps } from '../test-fixtures.js';
import type { AssistantRunContext } from '../../types.js';
import { CATEGORY_NAME_PATTERN, SOURCE_ID_PATTERN, USER_LIMITS } from './user-schemas.js';

const ADMIN_CLAIMS = { sub: 'admin-sub', 'cognito:groups': 'admins', 'cognito:username': 'admin-1' };
const admin = fakeContext('settings', {}, { isAdmin: true, claims: ADMIN_CLAIMS });
const user = fakeContext('settings');

const UUID = '5f1c2a6e-0000-4000-8000-000000000001';
const CREATE = { email: 'jane@example.com', role: 'users' };
const UPDATE = { username: UUID, updates: { given_name: 'Janet' } };
const ACCESS = { username: UUID, categories: ['billing'] };
const USER_TOOLS = ['create_user', 'update_user', 'set_user_access'];
const ALL_FIVE = ['list_users', 'get_user_access', ...USER_TOOLS];

/** GET /users as the route answers it (`sub` and `flags` included; one row without a username). */
const USERS = {
  success: true,
  users: [
    { username: UUID, sub: 'sub-jane', email: 'Jane@Example.com', groups: ['users'], flags: { fallback_owner: false } },
    { username: 'admin-1', sub: 'admin-sub', email: 'root@example.com', groups: ['admins'] },
    { username: 'admin-2', sub: 'sub-2', email: 'second@example.com', groups: ['admins', 'users'] },
    { sub: 'orphan' },
  ],
};
const ROUTES = {
  'GET /users': USERS,
  'GET /settings/categories': { categories: [{ name: 'billing' }, { name: 'delivery' }, { bogus: true }], updated_at: null },
  'GET /settings/sources': { sources: [{ id: 'webscraper', label: 'Web' }, { id: 'github_issues' }] },
};

const USERS_READ = { call: { fn: 'users', method: 'GET', path: '/users', resource: '/users' }, sub: 'admin-sub' };
const settingsRead = (route: string) => ({
  call: { fn: 'settings', method: 'GET', path: `/settings/${route}`, resource: '/settings/{proxy+}', pathParameters: { proxy: route } },
  sub: 'admin-sub',
});

const tool = clientToolLookup();
const valid = (name: string, args: Record<string, unknown>) => tool(name).validate(args, admin).ok;
const summary = (name: string, args: Record<string, unknown>) => tool(name).summarize(args);
const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** Run `name`'s precheck over `routes` as `ctx`; the refusal and the reads it made. */
async function precheck(name: string, args: Record<string, unknown>, ctx: AssistantRunContext = admin, routes: Record<string, unknown> = ROUTES) {
  const deps = fakeDeps(routes);
  const refusal = await clientToolLookup(deps)(name).precheck?.(args, ctx);
  return { refusal, calls: deps.calls };
}

describe('create_user argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['email and role', CREATE, true],
    ['both names', { ...CREATE, given_name: 'Jane', family_name: 'Doe' }, true],
    ['a padded email (trimmed)', { ...CREATE, email: '  jane@example.com ' }, true],
    ['a 254-char email', { ...CREATE, email: `${'j'.repeat(USER_LIMITS.maxEmailLength - 12)}@example.com` }, true],
    ['a 255-char email', { ...CREATE, email: `${'j'.repeat(USER_LIMITS.maxEmailLength - 11)}@example.com` }, false],
    ['no role (never defaulted)', { email: 'jane@example.com' }, false],
    ['an unknown role', { ...CREATE, role: 'owner' }, false],
    ['no "@"', { ...CREATE, email: 'jane.example.com' }, false],
    ['nothing before the "@"', { ...CREATE, email: '@example.com' }, false],
    ['nothing after the "@"', { ...CREATE, email: 'jane@' }, false],
    ['two "@"', { ...CREATE, email: 'jane@@example.com' }, false],
    ['inner whitespace', { ...CREATE, email: 'ja ne@example.com' }, false],
    ['a 100-char first name', { ...CREATE, given_name: 'J'.repeat(USER_LIMITS.maxNameLength) }, true],
    ['a 101-char first name', { ...CREATE, given_name: 'J'.repeat(USER_LIMITS.maxNameLength + 1) }, false],
    ['a blank last name', { ...CREATE, family_name: '   ' }, false],
    ['the REST body key "group"', { ...CREATE, group: 'users' }, false],
    ['the REST body key "name"', { ...CREATE, name: 'Jane Doe' }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('create_user', args)).toBe(expected);
  });
});

describe('update_user argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['one changed name', UPDATE, true],
    ['every editable field', { username: UUID, updates: { given_name: 'J', family_name: 'D', role: 'admins', enabled: false } }, true],
    ['an email alias as username', { ...UPDATE, username: 'jane+voc@example.com' }, true],
    ['a 128-char username', { ...UPDATE, username: 'u'.repeat(USER_LIMITS.maxUsernameLength) }, true],
    ['a 129-char username', { ...UPDATE, username: 'u'.repeat(USER_LIMITS.maxUsernameLength + 1) }, false],
    ['a username with a slash', { ...UPDATE, username: 'a/b' }, false],
    ['empty updates', { username: UUID, updates: {} }, false],
    ['no updates', { username: UUID }, false],
    ['an email inside updates', { username: UUID, updates: { email: 'x@example.com' } }, false],
    ['a flag inside updates', { username: UUID, updates: { fallback_owner: true } }, false],
    ['an unknown role', { username: UUID, updates: { role: 'owner' } }, false],
    ['"enabled" as a string', { username: UUID, updates: { enabled: 'false' } }, false],
    ['a 101-char last name', { username: UUID, updates: { family_name: 'D'.repeat(USER_LIMITS.maxNameLength + 1) } }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('update_user', args)).toBe(expected);
  });
});

describe('set_user_access argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['a category list', ACCESS, true],
    ['every category', { ...ACCESS, categories: ['*'] }, true],
    ['50 categories', { ...ACCESS, categories: many(USER_LIMITS.maxCategories, 'c') }, true],
    ['51 categories', { ...ACCESS, categories: many(USER_LIMITS.maxCategories + 1, 'c') }, false],
    ['no category', { ...ACCESS, categories: [] }, false],
    ['"*" among names', { ...ACCESS, categories: ['*', 'billing'] }, false],
    ['a repeated category', { ...ACCESS, categories: ['billing', 'billing'] }, false],
    ['a category with a space', { ...ACCESS, categories: ['late delivery'] }, false],
    ['a category with "#"', { ...ACCESS, categories: ['#billing'] }, false],
    ['a 64-char category', { ...ACCESS, categories: ['c'.repeat(USER_LIMITS.maxCategoryNameLength)] }, true],
    ['a 65-char category', { ...ACCESS, categories: ['c'.repeat(USER_LIMITS.maxCategoryNameLength + 1)] }, false],
    ['sources null (the default rule)', { ...ACCESS, sources: null }, true],
    ['every source', { ...ACCESS, sources: ['*'] }, true],
    ['no source at all', { ...ACCESS, sources: [] }, true],
    ['a source list', { ...ACCESS, sources: ['webscraper', 'github_issues'] }, true],
    ['50 sources', { ...ACCESS, sources: many(USER_LIMITS.maxSources, 's') }, true],
    ['51 sources', { ...ACCESS, sources: many(USER_LIMITS.maxSources + 1, 's') }, false],
    ['"*" among source ids', { ...ACCESS, sources: ['*', 'webscraper'] }, false],
    ['a repeated source', { ...ACCESS, sources: ['webscraper', 'webscraper'] }, false],
    ['an uppercase source id', { ...ACCESS, sources: ['WebScraper'] }, false],
    ['a source id starting with "-"', { ...ACCESS, sources: ['-web'] }, false],
    ['a 48-char source id', { ...ACCESS, sources: ['s'.repeat(USER_LIMITS.maxSourceIdLength)] }, true],
    ['a 49-char source id', { ...ACCESS, sources: ['s'.repeat(USER_LIMITS.maxSourceIdLength + 1)] }, false],
    ['the REST key "all"', { ...ACCESS, all: true }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('set_user_access', args)).toBe(expected);
  });

  it('trims every granted name', () => {
    expect(tool('set_user_access').validate({ username: ` ${UUID} `, categories: [' billing '], sources: [' webscraper'] }, admin))
      .toStrictEqual({ ok: true, args: { username: UUID, categories: ['billing'], sources: ['webscraper'] } });
  });
});

describe('the grant patterns the SPA lockstep mirrors (category_config._NAME_RE, source_profiles.SOURCE_ID_RE)', () => {
  it.each<[RegExp, string, boolean]>([
    [CATEGORY_NAME_PATTERN, 'late_delivery', true],
    [CATEGORY_NAME_PATTERN, 'Späte-Lieferung', true],
    [CATEGORY_NAME_PATTERN, 'late delivery', false],
    [CATEGORY_NAME_PATTERN, 'a#b', false],
    [CATEGORY_NAME_PATTERN, '', false],
    [SOURCE_ID_PATTERN, 'github_issues', true],
    [SOURCE_ID_PATTERN, '9lives-app', true],
    [SOURCE_ID_PATTERN, 'WebScraper', false],
    [SOURCE_ID_PATTERN, '_private', false],
    [SOURCE_ID_PATTERN, 'a.b', false],
  ])('%s.test(%j) → %s', (pattern, value, expected) => {
    expect(pattern.test(value)).toBe(expected);
  });
});

describe('summaries', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['create_user', { ...CREATE, given_name: 'Jane' }, 'Create user jane@example.com (users).'],
    ['update_user', { username: UUID, updates: { given_name: 'J', role: 'admins' } }, `Update user ${UUID}: given_name, role.`],
    ['set_user_access', { ...ACCESS, categories: ['*'] }, `Set access for user ${UUID}: all categories.`],
    ['set_user_access', { ...ACCESS, categories: ['a', 'b', 'c'], sources: null }, `Set access for user ${UUID}: 3 categories, default sources.`],
    ['set_user_access', { ...ACCESS, sources: ['*'] }, `Set access for user ${UUID}: 1 category, all sources.`],
    ['set_user_access', { ...ACCESS, categories: ['a', 'b'], sources: ['webscraper'] }, `Set access for user ${UUID}: 2 categories, 1 source.`],
    ['set_user_access', { ...ACCESS, sources: [] }, `Set access for user ${UUID}: 1 category, 0 sources.`],
  ])('%s → %s', (name, args, expected) => {
    expect(summary(name, args)).toBe(expected);
  });
});

describe('the specs the model reads', () => {
  const schemaOf = (name: string) => tool(name).spec.toolSpec?.inputSchema?.json;

  it('describes every user tool as admin-only, requiring approval', () => {
    for (const name of USER_TOOLS) {
      expect(tool(name).spec.toolSpec?.description).toMatch(/\(admin\).*approval/s);
    }
  });

  it('declares the contract bounds on create_user and update_user', () => {
    expect(schemaOf('create_user')).toMatchObject({
      properties: { email: { type: 'string', maxLength: 254 }, role: { type: 'string', enum: ['admins', 'users'] }, given_name: { maxLength: 100 } },
      required: ['email', 'role'],
      additionalProperties: false,
    });
    expect(schemaOf('update_user')).toMatchObject({
      properties: { username: { maxLength: 128 }, updates: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
      required: ['username', 'updates'],
    });
  });

  it('spells the nullable sources as anyOf (the Anthropic API refuses array-form types) and bounds both grants', () => {
    expect(schemaOf('set_user_access')).toMatchObject({
      properties: {
        categories: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 64 } },
        sources: { anyOf: [{ type: 'array', maxItems: 50, items: { type: 'string', maxLength: 48 } }, { type: 'null' }] },
      },
      required: ['username', 'categories'],
    });
    expect(JSON.stringify(schemaOf('set_user_access'))).not.toContain('"type":[');
  });
});

describe('admin gating', () => {
  it.each(USER_TOOLS)('%s is admin-only and refused for a non-admin', (name) => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(name);
    expect(tool(name).validate(CREATE, user)).toStrictEqual({ ok: false, error: `${name} is only available to administrators.` });
  });

  it('offers an admin on the Settings page all five user tools, and a non-admin none — not even via the thread tail', () => {
    const offered = (isAdmin: boolean) => selectToolset(buildCatalogue(fakeDeps()), { page: user.page, isAdmin, webSearch: false, alsoInclude: ALL_FIVE })
      .tools.map((named) => named.name);
    expect(ADMIN_ONLY_SERVER_TOOLS).toStrictEqual(expect.arrayContaining(['list_users', 'get_user_access']));
    expect(offered(true)).toStrictEqual(expect.arrayContaining(ALL_FIVE));
    expect(offered(false).filter((name) => ALL_FIVE.includes(name))).toStrictEqual([]);
  });
});

describe('create_user precheck (before any card)', () => {
  it('refuses an email that exists, case-insensitively, naming the username', async () => {
    const { refusal } = await precheck('create_user', { ...CREATE, email: 'JANE@example.com' });
    expect(refusal).toBe(`a user with email "JANE@example.com" already exists (username ${UUID}). To change them, propose update_user.`);
  });

  it('lets a new email through after one GET /users as the caller', async () => {
    const { refusal, calls } = await precheck('create_user', { ...CREATE, email: 'new@example.com' });
    expect(refusal).toBeUndefined();
    expect(calls).toStrictEqual([USERS_READ]);
  });

  it('refuses (by throwing) when the listing cannot be read — nothing unverified is proposed', async () => {
    await expect(precheck('create_user', CREATE, admin, {})).rejects.toThrow('unexpected route GET /users');
  });
});

describe('update_user precheck (before any card)', () => {
  it('refuses a username nobody has, and reads the list as the caller', async () => {
    const { refusal, calls } = await precheck('update_user', { ...UPDATE, username: 'ghost' });
    expect(refusal).toBe('no user has username "ghost". Read list_users first.');
    expect(calls).toStrictEqual([USERS_READ]);
  });

  it('passes a name change of an existing user, and a role change of ANOTHER administrator', async () => {
    expect((await precheck('update_user', UPDATE)).refusal).toBeUndefined();
    expect((await precheck('update_user', { username: 'admin-2', updates: { role: 'users', enabled: false } })).refusal).toBeUndefined();
  });

  it.each([{ role: 'users' }, { enabled: false }, { given_name: 'Root', enabled: true }])(
    'refuses the caller\u2019s own account change %o',
    async (updates) => {
      const { refusal } = await precheck('update_user', { username: 'admin-1', updates });
      expect(refusal).toBe('you cannot change your own role or enabled state. Another administrator must do that.');
    },
  );

  it('lets the caller rename themselves', async () => {
    expect((await precheck('update_user', { username: 'admin-1', updates: { family_name: 'Root' } })).refusal).toBeUndefined();
  });

  it('recognises the caller by subject when the token carries no username claim', async () => {
    const bySub = fakeContext('settings', {}, { isAdmin: true, claims: { sub: 'admin-sub' } });
    const { refusal } = await precheck('update_user', { username: 'admin-1', updates: { role: 'users' } }, bySub);
    expect(refusal).toBe('you cannot change your own role or enabled state. Another administrator must do that.');
  });
});

describe('set_user_access precheck (before any card)', () => {
  it('refuses a username nobody has', async () => {
    const { refusal, calls } = await precheck('set_user_access', { ...ACCESS, username: 'ghost' });
    expect(refusal).toBe('no user has username "ghost". Read list_users first.');
    expect(calls).toStrictEqual([USERS_READ]);
  });

  it('refuses an administrator (they see everything) by email, before reading any settings', async () => {
    const { refusal, calls } = await precheck('set_user_access', { ...ACCESS, username: 'admin-2' });
    expect(refusal).toBe('second@example.com is an administrator; administrators always see every category, so access rules do not apply to them.');
    expect(calls).toStrictEqual([USERS_READ]);
  });

  it('refuses unknown categories, listing the configured names, after reading them as the caller', async () => {
    const { refusal, calls } = await precheck('set_user_access', { ...ACCESS, categories: ['billing', 'refunds', 'legal'] });
    expect(refusal).toBe('unknown categories: refunds, legal. The configured categories are: billing, delivery.');
    expect(calls).toStrictEqual([USERS_READ, settingsRead('categories')]);
  });

  it('accepts "other" (reviews without a category) although it is not configured, like the API', async () => {
    const { refusal } = await precheck('set_user_access', { ...ACCESS, categories: ['billing', 'other'] });
    expect(refusal).toBeUndefined();
  });

  it('passes configured categories, and does not read them for ["*"]', async () => {
    const named = await precheck('set_user_access', { ...ACCESS, categories: ['delivery', 'billing'] });
    expect(named).toStrictEqual({ refusal: undefined, calls: [USERS_READ, settingsRead('categories')] });
    const every = await precheck('set_user_access', { ...ACCESS, categories: ['*'] });
    expect(every).toStrictEqual({ refusal: undefined, calls: [USERS_READ] });
  });

  it('accepts any name when no category is configured (the route then grants its built-in defaults)', async () => {
    const routes = { ...ROUTES, 'GET /settings/categories': { categories: [], updated_at: null } };
    expect((await precheck('set_user_access', { ...ACCESS, categories: ['anything'] }, admin, routes)).refusal).toBeUndefined();
  });

  it('refuses unknown sources, listing the configured ids, after both settings reads', async () => {
    const { refusal, calls } = await precheck('set_user_access', { ...ACCESS, sources: ['webscraper', 'twitter'] });
    expect(refusal).toBe('unknown sources: twitter. The configured source ids are: webscraper, github_issues.');
    expect(calls).toStrictEqual([USERS_READ, settingsRead('categories'), settingsRead('sources')]);
  });

  it.each<[string, unknown]>([['null', null], ['["*"]', ['*']], ['omitted', undefined]])('does not read the sources for %s', async (_label, sources) => {
    const { refusal, calls } = await precheck('set_user_access', { ...ACCESS, sources });
    expect(refusal).toBeUndefined();
    expect(calls).toStrictEqual([USERS_READ, settingsRead('categories')]);
  });

  it('passes configured sources, and says so when none are configured at all', async () => {
    expect((await precheck('set_user_access', { ...ACCESS, sources: ['github_issues'] })).refusal).toBeUndefined();
    const none = { ...ROUTES, 'GET /settings/sources': { sources: [] } };
    expect((await precheck('set_user_access', { ...ACCESS, sources: ['webscraper'] }, admin, none)).refusal)
      .toBe('unknown sources: webscraper. No source ids are configured.');
  });
});
