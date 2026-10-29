/**
 * The `participants` pack: list_participant_lists (a GET on the engagement API
 * as the caller, list fields only), create_participant_list and add_participants
 * (card-only, open to every signed-in user) — argument bounds, prechecks that
 * refuse before any card, page gating, guidance, and that neither may be a plan
 * step nor a think-step read.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, packsForPage } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { thinkTools } from '../../../plan-step/think.js';
import { buildCatalogue } from '../catalogue.js';
import { selectToolset, toolGuidance } from '../registry.js';
import { clientToolLookup, fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { LIST_ID_PATTERN, PARTICIPANT_LIMITS, isParticipantEmail } from './participant-schemas.js';

const LIST_ID = 'lst_0123456789abcdef';
const OTHER_ID = 'lst_fedcba9876543210';
const LISTS = {
  lists: [
    { list_id: LIST_ID, name: 'Beta customers', kind: 'beta', description: 'Booking beta', member_count: 4, created_by: 'sub-x' },
    { list_id: OTHER_ID, name: 'Sales team', kind: 'sales', member_count: 2 },
  ],
};
const ROUTES = { 'GET /participants/lists': LISTS };
const member = fakeContext('participants');
const tool = clientToolLookup();
const row = (i: number) => ({ email: `p${String(i)}@example.com` });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

async function precheck(name: string, args: Record<string, unknown>, routes: Record<string, unknown> = ROUTES) {
  const deps = fakeDeps(routes);
  return { refusal: await clientToolLookup(deps)(name).precheck?.(args, member), calls: deps.calls };
}

describe('list_participant_lists', () => {
  it('reads GET /participants/lists through the engagement API as the caller and keeps only list fields', async () => {
    const deps = fakeDeps(ROUTES);
    const result = await serverTool(deps, 'list_participant_lists').execute({}, member);
    expect(deps.calls).toStrictEqual([{
      call: { fn: 'engagement', method: 'GET', path: '/participants/lists', resource: '/participants/{proxy+}', pathParameters: { proxy: 'lists' } },
      sub: 'user-sub',
    }]);
    expect(JSON.parse(result.content)).toStrictEqual({
      count: 2,
      lists: [
        { list_id: LIST_ID, name: 'Beta customers', kind: 'beta', description: 'Booking beta', member_count: 4 },
        { list_id: OTHER_ID, name: 'Sales team', kind: 'sales', member_count: 2 },
      ],
    });
  });

  it('refuses arguments', async () => {
    await expect(serverTool(fakeDeps(ROUTES), 'list_participant_lists').execute({ q: 'x' }, member)).rejects.toThrow(/q/);
  });
});

describe('add_participants', () => {
  const valid = (args: Record<string, unknown>) => tool('add_participants').validate(args, member).ok;

  it.each<[string, Record<string, unknown>, boolean]>([
    ['one row', { list_id: LIST_ID, people: [row(0)] }, true],
    ['every field', { list_id: LIST_ID, people: [{ email: 'Ana.Lopez@Example.com', name: 'Ana Lopez', company: 'Example Air', title: 'Lead', tags: ['crew'] }] }, true],
    ['200 rows', { list_id: LIST_ID, people: rows(PARTICIPANT_LIMITS.maxPeople) }, true],
    ['201 rows', { list_id: LIST_ID, people: rows(PARTICIPANT_LIMITS.maxPeople + 1) }, false],
    ['no rows', { list_id: LIST_ID, people: [] }, false],
    ['the same email twice (collapsed on the card)', { list_id: LIST_ID, people: [row(1), { email: 'P1@example.com' }] }, true],
    ['an invalid email', { list_id: LIST_ID, people: [row(1), { email: 'not-an-address' }] }, false],
    ['an email without a dot domain', { list_id: LIST_ID, people: [{ email: 'a@localhost' }] }, false],
    ['a 255-character email', { list_id: LIST_ID, people: [{ email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}` }] }, false],
    ['an unknown key on a row', { list_id: LIST_ID, people: [{ ...row(1), phone: '1' }] }, false],
    ['21 tags', { list_id: LIST_ID, people: [{ ...row(1), tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) }] }, false],
    ['a list id that is not one', { list_id: 'Beta customers', people: [row(1)] }, false],
    ['no list id', { people: [row(1)] }, false],
  ])('%s → valid=%s', (_label, args, ok) => {
    expect(valid(args)).toBe(ok);
  });

  it('is open to every signed-in user and summarises the rows', () => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).not.toContain('add_participants');
    expect(tool('add_participants').summarize({ list_id: LIST_ID, people: rows(3) })).toBe(`Add 3 person rows to participant list ${LIST_ID}.`);
  });

  it('names the stored list on the approval card instead of its id', async () => {
    const deps = fakeDeps(ROUTES);
    const line = await clientToolLookup(deps)('add_participants').describe?.({ list_id: LIST_ID, people: rows(3) }, member);
    expect(line).toBe("Add 3 person rows to the participant list 'Beta customers'.");
  });

  it('passes a known list after one read of the lists', async () => {
    const { refusal, calls } = await precheck('add_participants', { list_id: LIST_ID, people: [row(1)] });
    expect(refusal).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('refuses an unknown list before the card, naming the lists', async () => {
    const { refusal } = await precheck('add_participants', { list_id: 'lst_00000000000000aa', people: [row(1)] });
    expect(refusal).toBe(`unknown list_id "lst_00000000000000aa". The lists are: 'Beta customers' (${LIST_ID}), 'Sales team' (${OTHER_ID}).`);
  });

  it('says to create a list first when there is none', async () => {
    const { refusal } = await precheck('add_participants', { list_id: LIST_ID, people: [row(1)] }, { 'GET /participants/lists': { lists: [] } });
    expect(refusal).toBe(`unknown list_id "${LIST_ID}". There are no participant lists yet: propose create_participant_list first.`);
  });
});

describe('the address and list id rules', () => {
  it.each([
    ['ana@example.com', true], ['Ana.Lopez+beta@Example.CO.uk', true], ['a@localhost', false], ['a@@example.com', false],
    ['a@example..com', false], ['a b@example.com', false], [`${'x'.repeat(65)}@example.com`, false],
  ])('%s → %s', (value, ok) => {
    expect(isParticipantEmail(value)).toBe(ok);
  });

  it('takes a list id as the route mints it (lst_ + 16 hex)', () => {
    expect([LIST_ID, 'lst_beta', 'lst_0123456789ABCDEF'].map((id) => LIST_ID_PATTERN.test(id))).toStrictEqual([true, false, false]);
  });
});

describe('create_participant_list', () => {
  const valid = (args: Record<string, unknown>) => tool('create_participant_list').validate(args, member).ok;

  it.each<[string, Record<string, unknown>, boolean]>([
    ['name and kind', { name: 'Paid panel', kind: 'paid' }, true],
    ['with a description', { name: 'Paid panel', kind: 'paid', description: 'Paid research panel' }, true],
    ['no kind', { name: 'Paid panel' }, false],
    ['an unknown kind', { name: 'Paid panel', kind: 'vip' }, false],
    ['a blank name', { name: '  ', kind: 'custom' }, false],
    ['a 121-character name', { name: 'n'.repeat(PARTICIPANT_LIMITS.maxListNameChars + 1), kind: 'custom' }, false],
  ])('%s → valid=%s', (_label, args, ok) => {
    expect(valid(args)).toBe(ok);
  });

  it('summarises the list', () => {
    expect(tool('create_participant_list').summarize({ name: 'Paid panel', kind: 'paid' })).toBe("Create the participant list 'Paid panel' (paid).");
  });

  it('refuses a name already used (any case) before the card', async () => {
    const { refusal } = await precheck('create_participant_list', { name: 'beta CUSTOMERS', kind: 'beta' });
    expect(refusal).toBe(`a list named 'Beta customers' already exists (list_id ${LIST_ID}). Add people to it with add_participants instead.`);
    expect((await precheck('create_participant_list', { name: 'Paid panel', kind: 'paid' })).refusal).toBeUndefined();
  });
});

describe('the participants page and plans', () => {
  const NAMES = ['list_participant_lists', 'create_participant_list', 'add_participants'];

  it('loads core + participants on /participants, for users and admins alike, with its guidance', () => {
    expect(packsForPage('participants', false)).toStrictEqual(['core', 'participants']);
    const toolset = selectToolset(buildCatalogue(fakeDeps()), { page: { kind: 'participants', path: '/participants' }, isAdmin: false, webSearch: false });
    expect(NAMES.every((name) => toolset.byName.has(name))).toBe(true);
    expect(toolGuidance(toolset)).toContain('propose ONE add_participants');
  });

  it('is not on other pages', () => {
    const toolset = selectToolset(buildCatalogue(fakeDeps()), { page: { kind: 'project', path: '/projects/p1' }, isAdmin: true, webSearch: false });
    expect(NAMES.filter((name) => toolset.byName.has(name))).toStrictEqual([]);
    expect(toolGuidance(toolset)).not.toContain('add_participants');
  });

  it('keeps both writes card-only and the read out of think steps', () => {
    expect(CARD_ONLY_WRITE_TOOLS).toContain('create_participant_list');
    expect(CARD_ONLY_WRITE_TOOLS).toContain('add_participants');
    expect(planWriteTools('participants')).toStrictEqual([]);
    const reads = thinkTools({ catalogue: buildCatalogue(fakeDeps()) }, 'participants', true).map((t) => t.name);
    expect(reads).not.toContain('list_participant_lists');
  });
});
