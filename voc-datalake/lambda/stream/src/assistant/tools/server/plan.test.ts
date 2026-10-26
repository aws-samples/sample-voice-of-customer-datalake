import { describe, expect, it } from 'vitest';
import { buildCatalogue } from '../catalogue.js';
import { clientToolLookup, fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { plannableTools } from './plan.js';

const admin = fakeContext('home', {}, { isAdmin: true });
const user = fakeContext('home');

describe('plan_catalogue', () => {
  async function lines(ctx = user) {
    return (await serverTool(fakeDeps(), 'plan_catalogue').execute({}, ctx)).content.split('\n');
  }

  it('tells the planner to scope generation jobs with approved literals and sources', async () => {
    const rules = (await lines(admin)).join('\n');
    expect(rules).toContain('never "{{free}}"');
    expect(rules).toContain('"<app_name>_iOS"');
    expect(rules).toContain('"web_<site>_<app_name>"');
    expect(rules).toContain('sources ["web_trustpilot_example_air"]');
  });

  it('lists the tools of other pages with kind, free-text fields and the "asks again" flag', async () => {
    const admins = await lines(admin);
    expect(admins.find((line) => line.startsWith('- create_project |'))).toMatch(/core \| write \| free: description — /);
    expect(admins.find((line) => line.startsWith('- generate_personas |'))).toMatch(/project \| write — /);
    expect(admins.find((line) => line.startsWith('- run_source |'))).toContain('admin-only');
    expect(admins.find((line) => line.startsWith('- delete_document |'))).toContain('asks again at run time');
  });

  it('leaves admin-only packs and tools out for a non-administrator', async () => {
    const names = (await lines()).filter((line) => line.startsWith('- ')).map((line) => line.split(' | ')[0]);
    expect(names).toContain('- list_scrapers');
    expect(names.filter((name) => ['- run_source', '- get_categories_config', '- analyze_scraper_url'].includes(name ?? ''))).toStrictEqual([]);
  });

  it('never lists the plan tools themselves', () => {
    const names = plannableTools(buildCatalogue(fakeDeps()), true).map((tool) => tool.name);
    expect(names.filter((name) => ['propose_plan', 'cancel_plan', 'plan_lookup', 'plan_catalogue', 'get_plan'].includes(name))).toStrictEqual([]);
  });
});

describe('plan_lookup', () => {
  it('runs a read tool of a pack this page does not load, as the caller', async () => {
    const deps = fakeDeps({ 'GET /scrapers': { scrapers: [{ id: 'sc_1', name: 'Reviews' }] } });
    const result = await serverTool(deps, 'plan_lookup').execute({ tool: 'list_scrapers', args: {} }, user);
    expect(result.content).toContain('sc_1');
    expect(deps.calls[0]?.sub).toBe('user-sub');
  });

  it('refuses a write tool, an admin-only read for a non-admin, and an unknown tool', async () => {
    const lookup = serverTool(fakeDeps(), 'plan_lookup');
    await expect(lookup.execute({ tool: 'create_project', args: { name: 'x' } }, admin)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(lookup.execute({ tool: 'get_source_run', args: { source: 's3_import' } }, user)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(lookup.execute({ tool: 'nope' }, admin)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('passes the arguments to the tool\u2019s own validation', async () => {
    await expect(serverTool(fakeDeps(), 'plan_lookup').execute({ tool: 'get_scraper_status', args: { scraper_id: '../x' } }, user))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses web_search while web search is off', async () => {
    await expect(serverTool(fakeDeps(), 'plan_lookup').execute({ tool: 'web_search', args: { query: 'x' } }, user))
      .rejects.toMatchObject({ code: 'not_permitted' });
  });
});

describe('get_plan', () => {
  it('reads the plan through the agents API as the caller and returns its view', async () => {
    const deps = fakeDeps({ 'GET /agents/plans/pl_0123456789ab': { plan: { plan_id: 'pl_0123456789ab', status: 'running', steps: [] } } });
    const result = await serverTool(deps, 'get_plan').execute({ plan_id: 'pl_0123456789ab' }, user);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'running' });
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'agents', resource: '/agents/{proxy+}', pathParameters: { proxy: 'plans/pl_0123456789ab' } });
  });

  it('refuses anything that is not a plan id', async () => {
    await expect(serverTool(fakeDeps(), 'get_plan').execute({ plan_id: 'ag_0123456789ab' }, user)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('propose_plan', () => {
  const tool = clientToolLookup()('propose_plan');
  const step = (args: Record<string, unknown>) => ({ id: 's1', pack: 'core', kind: 'write', title: 'Create', write: { tool: 'create_project', args } });
  const plan = (args: Record<string, unknown>) => ({ schema: 'voc-plan/1', goal: 'A project', steps: [step(args)] });

  it('accepts a valid plan as the approval arguments', () => {
    expect(tool.validate(plan({ name: 'Ancillaries', description: '{{free}}' }), user)).toStrictEqual({ ok: true, args: plan({ name: 'Ancillaries', description: '{{free}}' }) });
  });

  it('answers an invalid literal with the error list instead of a card', () => {
    const result = tool.validate(plan({ name: 'x'.repeat(300) }), user);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('"field":"write.args.name"');
  });

  it('refuses an admin-only pack for a non-administrator', () => {
    const settings = { schema: 'voc-plan/1', goal: 'Brand', steps: [{ id: 's1', pack: 'settings', kind: 'think', title: 'Brand', think: { brief: 'Review the brand settings.' } }] };
    expect(tool.validate(settings, user).ok).toBe(false);
    expect(tool.validate(settings, admin).ok).toBe(true);
  });

  it('refuses a card-only write even for an administrator', () => {
    const brand = { schema: 'voc-plan/1', goal: 'Brand', steps: [{ id: 's1', pack: 'settings', kind: 'write', title: 'Brand', write: { tool: 'save_brand_settings', args: { brand_name: 'A' } } }] };
    expect(tool.validate(brand, admin)).toMatchObject({ ok: false, error: expect.stringContaining('not a write tool of pack settings') });
  });

  it('summarizes the goal and the step count', () => {
    expect(tool.summarize(plan({ name: 'A' }))).toBe("Run the plan 'A project' (1 steps).");
  });
});
