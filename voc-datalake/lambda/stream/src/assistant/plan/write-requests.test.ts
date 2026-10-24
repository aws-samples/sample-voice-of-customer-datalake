import { describe, expect, it } from 'vitest';
import { clientToolLookup, fakeContext } from '../tools/test-fixtures.js';
import { CASE_ENV, UPDATE_SCRAPER_CASE, WEB_REVIEWS_CONNECTOR_CASE, WRITE_REQUEST_CASES } from './write-request-fixtures.js';
import { WriteRequestError } from './write-args.js';
import { preconditionFor, settlePrecondition } from './write-preconditions.js';
import { storedScraperRecord } from './scraper-records.js';
import { PLAN_STEP_WRITE_TOOLS, buildWriteRequest, extractOutputs, forbiddenFallback } from './write-requests.js';

const byName = (a: string, b: string) => a.localeCompare(b);
const tool = clientToolLookup();
const admin = fakeContext('settings', {}, { isAdmin: true });

describe('buildWriteRequest', () => {
  it('has one case for every write a plan step may name, and none for the card-only or plan-control tools', () => {
    const cases = [...WRITE_REQUEST_CASES.map((c) => c.tool), UPDATE_SCRAPER_CASE.tool];
    cases.sort(byName);
    const plannable = [...PLAN_STEP_WRITE_TOOLS];
    plannable.sort(byName);
    expect(cases).toStrictEqual(plannable);
    expect(PLAN_STEP_WRITE_TOOLS.filter((name) => ['save_brand_settings', 'create_user', 'update_user', 'set_user_access', 'propose_plan', 'cancel_plan'].includes(name))).toStrictEqual([]);
  });

  it.each(WRITE_REQUEST_CASES.map((c) => [c.tool, c] as const))('%s fixture arguments pass the tool\u2019s own validation', (name, c) => {
    expect(tool(name).validate(c.args, admin)).toMatchObject({ ok: true });
  });

  it.each(WRITE_REQUEST_CASES.map((c) => [c.tool, c] as const))('%s becomes the SPA executor\u2019s request', (name, c) => {
    expect(buildWriteRequest(name, c.args, CASE_ENV)).toStrictEqual(c.request);
  });

  it('merges update_scraper into the stored scraper', () => {
    expect(buildWriteRequest('update_scraper', UPDATE_SCRAPER_CASE.args, { ...CASE_ENV, current: UPDATE_SCRAPER_CASE.current })).toStrictEqual(UPDATE_SCRAPER_CASE.request);
  });

  it('saves a web_reviews page as its target (url, max_pages default 10, no review limit)', () => {
    const c = WEB_REVIEWS_CONNECTOR_CASE;
    expect(tool(c.tool).validate(c.args, admin)).toMatchObject({ ok: true });
    expect(buildWriteRequest(c.tool, c.args, CASE_ENV)).toStrictEqual(c.request);
  });

  it('refuses a web_reviews page that is already configured', () => {
    const args = WEB_REVIEWS_CONNECTOR_CASE.args;
    expect(preconditionFor('create_app_connector', args)).toMatchObject({ path: '/integrations/web_reviews/apps' });
    expect(settlePrecondition('create_app_connector', args, { apps: [{ app_name: 'Other', url: ' https://www.trustpilot.com/review/WWW.EXAMPLE-AIR.COM' }] })).toMatchObject({ ok: false });
  });

  it('refuses a merge write without the stored state, a card-only tool and an unknown tool', () => {
    expect(() => buildWriteRequest('update_scraper', UPDATE_SCRAPER_CASE.args, CASE_ENV)).toThrow(WriteRequestError);
    expect(() => buildWriteRequest('save_brand_settings', { brand_name: 'A' }, CASE_ENV)).toThrow(WriteRequestError);
    expect(() => buildWriteRequest('drop_everything', {}, CASE_ENV)).toThrow(WriteRequestError);
  });

  it('omits the date basis, language and author the env does not have', () => {
    const body = buildWriteRequest('generate_personas', { project_id: 'p', persona_count: 3 }, { days: 7, editId: 'e' }).body;
    expect(body).toStrictEqual({ sources: [], categories: [], sentiments: [], persona_count: 3, custom_instructions: '', days: 7 });
    expect(buildWriteRequest('add_persona_note', { project_id: 'p', persona_id: 'q', text: 't' }, { days: 7, editId: 'e' }).body).toStrictEqual({ text: 't' });
  });

  it('fills the omitted half of the company context from the stored document', () => {
    const request = buildWriteRequest('update_company_context', { vision: 'New' }, { ...CASE_ENV, current: { vision: 'Old', objectives: [{ title: 'Keep' }] } });
    expect(request.body).toStrictEqual({ vision: 'New', objectives: [{ title: 'Keep' }] });
  });

  it('files a refused company-memory edit as a company proposal', () => {
    expect(forbiddenFallback('update_company_memory', { memory_id: 'm', statement: 'S', kind: 'product' })).toMatchObject({ method: 'POST', path: '/memory', body: { scope: 'company', statement: 'S', kind: 'product' } });
    expect(forbiddenFallback('create_project', { name: 'x' })).toBeUndefined();
  });
});

describe('write preconditions', () => {
  it('reads only what a write needs', () => {
    expect(preconditionFor('create_scraper', { id: 'a' })).toMatchObject({ method: 'GET', path: '/scrapers' });
    expect(preconditionFor('update_company_context', { vision: 'V', objectives: [] })).toBeUndefined();
    expect(preconditionFor('create_project', { name: 'x' })).toBeUndefined();
  });

  it('refuses a create over an existing scraper and an update of a missing one', () => {
    const stored = { scrapers: [{ id: 'sc_1', name: 'Old' }] };
    expect(settlePrecondition('create_scraper', { id: 'sc_1' }, stored)).toMatchObject({ ok: false, refusal: expect.stringContaining('already exists') });
    expect(settlePrecondition('update_scraper', { scraper_id: 'sc_9', updates: {} }, stored)).toMatchObject({ ok: false });
    expect(settlePrecondition('update_scraper', { scraper_id: 'sc_1', updates: {} }, stored)).toMatchObject({ ok: true, current: { id: 'sc_1', name: 'Old', base_url: '' } });
  });

  it('normalises a stored scraper as the SPA reads it: defaults for missing fields, malformed optional ones dropped', () => {
    const current = storedScraperRecord({ id: 'sc_1', enabled: 'yes', frequency_minutes: '15', title_selector: 3, extraction_method: 'xpath', extra: 1, pagination: { max_pages: '2' } });
    expect(current).toStrictEqual({
      id: 'sc_1', extra: 1, name: '', enabled: false, base_url: '', urls: [], frequency_minutes: 15, container_selector: '', text_selector: '',
      pagination: { enabled: false, param: 'page', max_pages: 2, start: 1 },
    });
  });

  it('refuses an app connector that is already configured by name or id', () => {
    const args = { source: 'app_reviews_ios', app_name: 'ExampleAir iOS', app_id: '1' };
    expect(settlePrecondition('create_app_connector', args, { apps: [{ app_name: 'exampleair ios ', app_id: '2' }] })).toMatchObject({ ok: false });
    expect(settlePrecondition('create_app_connector', args, { apps: [{ app_name: 'Other', app_id: '1' }] })).toMatchObject({ ok: false });
    expect(settlePrecondition('create_app_connector', args, { apps: [] })).toStrictEqual({ ok: true });
  });
});

describe('extractOutputs', () => {
  it.each([
    ['create_project', { success: true, project: { project_id: 'p1' } }, { project_id: 'p1' }],
    ['generate_personas', { success: true, job_id: 'j1', status: 'pending' }, { job_id: 'j1' }],
    ['run_source', { success: true, execution_id: 'run_x' }, { execution_id: 'run_x' }],
    ['create_app_connector', { success: true, app: { id: 'app_1', app_name: 'A' } }, { app_config_id: 'app_1' }],
    ['create_document', { document: { document_id: 'd1' } }, { document_id: 'd1' }],
    ['create_agent', { agent: { agent_id: 'ag_1' } }, { agent_id: 'ag_1' }],
    ['run_agent', { run_id: 'ar_1' }, { run_id: 'ar_1' }],
  ] as const)('%s reports its ids', (name, response, outputs) => {
    expect(extractOutputs(name, response)).toStrictEqual(outputs);
  });

  it('joins persona ids, takes a created scraper\u2019s id from its arguments and ignores non-objects', () => {
    expect(extractOutputs('x', { persona_ids: ['a', 'b', 3] })).toStrictEqual({ persona_ids: 'a,b' });
    expect(extractOutputs('create_scraper', { success: true }, { id: 'acme' })).toStrictEqual({ scraper_id: 'acme' });
    expect(extractOutputs('x', 'not json')).toStrictEqual({});
  });

  it('caps an output at 500 characters', () => {
    expect(extractOutputs('x', { job_id: 'j'.repeat(900) }).job_id).toHaveLength(500);
  });
});
