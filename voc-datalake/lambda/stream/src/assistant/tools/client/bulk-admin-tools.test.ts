/**
 * The bulk admin write tools: create_users (several create_user rows in one
 * approval), import_reviews (rows extracted from a paste or an attachment) and
 * set_source_enabled (a plugin's schedule on/off) — argument bounds, admin
 * gating, summaries, prechecks read as the caller, and the plan-mode status of
 * each (only set_source_enabled may be a plan step).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ADMIN_ONLY_CLIENT_TOOLS } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { buildWriteRequest } from '../../plan/write-requests.js';
import { clientToolLookup, fakeContext, fakeDeps } from '../test-fixtures.js';
import { REVIEW_IMPORT_LIMITS } from './review-import-schemas.js';
import { SCHEDULED_SOURCE_IDS } from './scraper-schemas.js';
import { USER_LIMITS } from './user-schemas.js';

const admin = fakeContext('settings', {}, { isAdmin: true, claims: { sub: 'admin-sub', 'cognito:groups': 'admins', 'cognito:username': 'admin-1' } });
const member = fakeContext('scrapers');
const tool = clientToolLookup();
const valid = (name: string, args: Record<string, unknown>) => tool(name).validate(args, admin).ok;

const ROUTES = {
  'GET /users': { success: true, users: [{ username: 'u-jane', email: 'Jane@Example.com', groups: ['users'] }] },
  'GET /settings/sources': { sources: [{ id: 'webscraper' }, { id: 'survey_q3' }] },
};

async function precheck(name: string, args: Record<string, unknown>) {
  const deps = fakeDeps(ROUTES);
  return { refusal: await clientToolLookup(deps)(name).precheck?.(args, admin), calls: deps.calls };
}

/** Plugin manifests (vitest resolves the glob at build time); `_template` is not a plugin. */
const MANIFESTS = import.meta.glob<string>('../../../../../../plugins/*/manifest.json', { eager: true, query: '?raw', import: 'default' });
const ingestorScheduleSchema = z.object({ infrastructure: z.object({ ingestor: z.object({ schedule: z.string().min(1) }) }) });
const byName = (a: string, b: string) => a.localeCompare(b);
/** Plugins whose manifest sets `infrastructure.ingestor.schedule`. */
const SCHEDULED_PLUGINS = Object.entries(MANIFESTS)
  .map(([file, raw]) => [file.split('/').at(-2) ?? '_', raw] as const)
  .filter(([id, raw]) => !id.startsWith('_') && ingestorScheduleSchema.safeParse(JSON.parse(raw)).success)
  .map(([id]) => id);

describe('admin gating', () => {
  it.each(['create_users', 'import_reviews', 'set_source_enabled'])('%s is admin-only and refused for a users-role caller', (name) => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(name);
    expect(tool(name).validate({}, member)).toStrictEqual({ ok: false, error: `${name} is only available to administrators.` });
  });

  it('keeps create_users and import_reviews out of plans and lets set_source_enabled be a plan step', () => {
    expect(CARD_ONLY_WRITE_TOOLS.filter((name) => name === 'create_users' || name === 'import_reviews')).toStrictEqual(['create_users', 'import_reviews']);
    expect(planWriteTools('settings')).not.toContain('create_users');
    expect(planWriteTools('scrapers')).not.toContain('import_reviews');
    expect(planWriteTools('scrapers')).toContain('set_source_enabled');
  });
});

describe('create_users', () => {
  const row = (i: number) => ({ email: `p${i}@example.com`, role: 'users' });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['one row', { users: [row(0)] }, true],
    ['25 rows', { users: Array.from({ length: USER_LIMITS.maxUsersPerCard }, (_, i) => row(i)) }, true],
    ['26 rows', { users: Array.from({ length: USER_LIMITS.maxUsersPerCard + 1 }, (_, i) => row(i)) }, false],
    ['no rows', { users: [] }, false],
    ['the same email twice (any case)', { users: [row(1), { email: 'P1@example.com', role: 'admins' }] }, false],
    ['a row without its role', { users: [{ email: 'a@example.com' }] }, false],
    ['a row with an unknown key', { users: [{ ...row(1), username: 'x' }] }, false],
  ])('%s → valid=%s', (_label, args, ok) => {
    expect(valid('create_users', args)).toBe(ok);
  });

  it('summarises the count', () => {
    expect(tool('create_users').summarize({ users: [row(1), row(2)] })).toBe('Create 2 users.');
  });

  it('refuses the first email that is already registered, after one read of GET /users', async () => {
    const { refusal, calls } = await precheck('create_users', { users: [row(1), { email: 'jane@example.com', role: 'users' }] });
    expect(refusal).toBe('a user with email "jane@example.com" already exists (username u-jane). To change them, propose update_user.');
    expect(calls).toHaveLength(1);
  });

  it('passes when every email is new', async () => {
    expect((await precheck('create_users', { users: [row(1), row(2)] })).refusal).toBeUndefined();
  });
});

describe('import_reviews', () => {
  const base = { source_name: 'Survey', items: [{ text: 'Checkout keeps failing.' }] };
  const L = REVIEW_IMPORT_LIMITS;

  it.each<[string, Record<string, unknown>, boolean]>([
    ['text only', base, true],
    ['every field', { ...base, source_id: 'survey_q3', items: [{ text: 't', rating: 4.5, author: 'A', created_at: '2026-03-01T09:30:00Z', url: 'https://reviews.example/1', title: 'Hm' }] }, true],
    ['a date-only created_at', { ...base, items: [{ text: 't', created_at: '2026-03-01' }] }, true],
    ['500 items', { ...base, items: Array.from({ length: L.maxItems }, () => ({ text: 't' })) }, true],
    ['501 items', { ...base, items: Array.from({ length: L.maxItems + 1 }, () => ({ text: 't' })) }, false],
    ['no items', { ...base, items: [] }, false],
    ['a 10,000-character review', { ...base, items: [{ text: 'x'.repeat(L.maxTextChars) }] }, true],
    ['a 10,001-character review', { ...base, items: [{ text: 'x'.repeat(L.maxTextChars + 1) }] }, false],
    ['more than 200,000 characters in total', { ...base, items: Array.from({ length: 21 }, () => ({ text: 'x'.repeat(L.maxTextChars) })) }, false],
    ['a blank review', { ...base, items: [{ text: '   ' }] }, false],
    ['a rating of 0', { ...base, items: [{ text: 't', rating: 0 }] }, false],
    ['a rating of 11', { ...base, items: [{ text: 't', rating: 11 }] }, false],
    ['a written-out date', { ...base, items: [{ text: 't', created_at: 'March 1st' }] }, false],
    ['a date-time with an offset and fraction', { ...base, items: [{ text: 't', created_at: '2026-03-01T09:30:00.123456+05:30' }] }, true],
    ['a month 13', { ...base, items: [{ text: 't', created_at: '2026-13-01' }] }, false],
    ['a time without minutes', { ...base, items: [{ text: 't', created_at: '2026-03-01T09' }] }, false],
    ['a non-http url', { ...base, items: [{ text: 't', url: 'javascript:alert(1)' }] }, false],
    ['an unknown item key', { ...base, items: [{ text: 't', sentiment: 'negative' }] }, false],
    ['a malformed source_id', { ...base, source_id: 'Survey Q3' }, false],
    ['a 129-character source name', { ...base, source_name: 'x'.repeat(L.maxSourceNameChars + 1) }, false],
  ])('%s → valid=%s', (_label, args, ok) => {
    expect(valid('import_reviews', args)).toBe(ok);
  });

  it('summarises the count and the source name', () => {
    expect(tool('import_reviews').summarize(base)).toBe('Import 1 review from \'Survey\'.');
  });

  it('accepts a configured source profile and the default without a second read', async () => {
    expect((await precheck('import_reviews', { ...base, source_id: 'survey_q3' })).refusal).toBeUndefined();
    expect(await precheck('import_reviews', base)).toStrictEqual({ refusal: undefined, calls: [] });
  });

  it('refuses a source profile nobody configured and names the configured ones', async () => {
    const { refusal } = await precheck('import_reviews', { ...base, source_id: 'trustpilot' });
    expect(refusal).toBe('unknown source_id "trustpilot". The configured source profiles are: webscraper, survey_q3. Omit source_id to file the reviews under manual_import.');
  });
});

describe('set_source_enabled', () => {
  it('names exactly the plugins whose manifest has a schedule', () => {
    expect(SCHEDULED_PLUGINS).toContain('webscraper');
    expect([...SCHEDULED_SOURCE_IDS].sort(byName)).toStrictEqual([...SCHEDULED_PLUGINS].sort(byName));
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['a scheduled plugin', { source: 'web_reviews', enabled: true }, true],
    ['a plugin without a schedule', { source: 'synthetic_reviews', enabled: true }, false],
    ['an unknown plugin', { source: 'twitter', enabled: false }, false],
    ['no state', { source: 'webscraper' }, false],
  ])('%s → valid=%s', (_label, args, ok) => {
    expect(valid('set_source_enabled', args)).toBe(ok);
  });

  it('summarises the new state', () => {
    expect(tool('set_source_enabled').summarize({ source: 'webscraper', enabled: true })).toBe('Enable the webscraper schedule.');
    expect(tool('set_source_enabled').summarize({ source: 'webscraper', enabled: false })).toBe('Disable the webscraper schedule.');
  });

  it('becomes PUT /sources/{source}/enable in a plan step', () => {
    expect(buildWriteRequest('set_source_enabled', { source: 'github_issues', enabled: true }, { days: 7, editId: 'e' })).toStrictEqual({
      fn: 'integrations', method: 'PUT', path: '/sources/github_issues/enable', resource: '/sources/{source}/{proxy+}',
      pathParameters: { source: 'github_issues', proxy: 'enable' },
    });
  });
});
