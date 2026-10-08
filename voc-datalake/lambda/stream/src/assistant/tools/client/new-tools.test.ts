import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, DESTRUCTIVE_CLIENT_TOOLS } from '../../contract.js';
import { clientToolLookup, fakeContext } from '../test-fixtures.js';
import { SAMPLE_WORKFLOW, validArgs } from './new-tools-fixtures.js';

const tool = clientToolLookup();

const user = fakeContext('memory');
const admin = fakeContext('agents', {}, { isAdmin: true });
const agentPage = fakeContext('agent', { agentId: 'ag_7' }, { isAdmin: true });

const ok = (name: string, args: Record<string, unknown>, ctx = admin) => tool(name).validate(args, ctx).ok;

describe('memory write tools', () => {
  // remember needs expires_at exactly with retention "dated", and bounds the rest.
  it.each<[Record<string, unknown>, boolean]>([
    [{ retention: 'dated', expires_at: '2026-12-31' }, true],
    [{ retention: 'dated' }, false],
    [{ retention: 'decay', expires_at: '2026-12-31' }, false],
    [{ expires_at: '31/12/2026' }, false],
    [{ statement: 'x'.repeat(501) }, false],
    [{ scope: 'team' }, false],
  ])('remember with %o → %s', (overrides, expected) => {
    expect(ok('remember', { ...validArgs('remember'), ...overrides }, user)).toBe(expected);
  });

  it('remember and update_company_memory are offered to every user (the memory Lambda applies the rules)', () => {
    expect(ok('remember', { ...validArgs('remember'), scope: 'company' }, user)).toBe(true);
    expect(ok('update_company_memory', validArgs('update_company_memory'), user)).toBe(true);
    expect(tool('remember').pack).toBe('core');
    expect(tool('update_company_memory').pack).toBe('core');
  });

  it('update_company_memory refuses an unchanged statement and summarizes old → new', () => {
    const args = validArgs('update_company_memory');
    expect(ok('update_company_memory', { ...args, statement: args.previous_statement }, user)).toBe(false);
    const result = tool('update_company_memory').validate(args, user);
    expect(result.ok ? tool('update_company_memory').summarize(result.args) : '')
      .toBe("Update company memory mem_1 for everyone: 'Pricing is per seat.' → 'Pricing is per workspace.'");
  });

  it('merge_memories needs 2-10 distinct ids', () => {
    expect(ok('merge_memories', { memory_ids: ['m1'], statement: 's' }, user)).toBe(false);
    expect(ok('merge_memories', { memory_ids: ['m1', 'm1'], statement: 's' }, user)).toBe(false);
    expect(ok('merge_memories', { memory_ids: Array.from({ length: 11 }, (_, i) => `m${i}`), statement: 's' }, user)).toBe(false);
  });

  it.each([
    [{ action: 'keep_both' }, true],
    [{ action: 'keep', winner_id: 'm2' }, true],
    [{ action: 'keep' }, false],
    [{ action: 'replace', winner_id: 'm2', statement: 'New' }, true],
    [{ action: 'replace', winner_id: 'm2' }, false],
    [{ action: 'merge', statement: 'Both' }, true],
    [{ action: 'merge', winner_id: 'm2', statement: 'Both' }, false],
    [{ action: 'keep_both', statement: 'x' }, false],
  ])('resolve_memory_conflict %o → %s', (args, expected) => {
    expect(ok('resolve_memory_conflict', { memory_id: 'm1', ...args }, user)).toBe(expected);
  });

  it('styles forget_memory and merge_memories as destructive, the rest as writes', () => {
    expect(tool('forget_memory').risk).toBe('destructive');
    expect(tool('merge_memories').risk).toBe('destructive');
    expect(tool('confirm_memory').risk).toBe('write');
    expect(DESTRUCTIVE_CLIENT_TOOLS).toStrictEqual(['delete_document', 'forget_memory', 'merge_memories']);
  });
});

describe('agent write tools', () => {
  it.each(['create_agent', 'update_agent', 'enable_agent', 'disable_agent', 'create_workflow', 'update_workflow',
    'duplicate_workflow', 'update_company_context', 'update_design_system'])('%s is refused for non-admins', (name) => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(name);
    expect(tool(name).validate(validArgs(name), user)).toMatchObject({ ok: false, error: expect.stringContaining('administrators') });
  });

  it('leaves run_agent, cancel_agent_run and update_my_context to the API for every user', () => {
    expect(ok('run_agent', { agent_id: 'ag_1' }, user)).toBe(true);
    expect(ok('cancel_agent_run', validArgs('cancel_agent_run'), user)).toBe(true);
    expect(ok('update_my_context', validArgs('update_my_context'), user)).toBe(true);
  });

  it('fills agent_id from the agent on screen', () => {
    expect(tool('run_agent').validate({}, agentPage)).toStrictEqual({ ok: true, args: { agent_id: 'ag_7' } });
    expect(tool('run_agent').validate({}, admin).ok).toBe(false);
    expect(tool('update_agent').validate({ updates: { instructions: 'x' }, change_summary: 'c' }, agentPage))
      .toMatchObject({ ok: true, args: { agent_id: 'ag_7' } });
  });

  // create_agent requires a non-empty scope and bounded triggers.
  it.each<[Record<string, unknown>, boolean]>([
    [{ scope: { all: false, categories: [], subcategories: [] } }, false],
    [{ triggers: [{ kind: 'schedule', every: '12h', timezone: 'Europe/Paris' }] }, true],
    [{ triggers: [{ kind: 'schedule', every: 'cron', timezone: 'UTC' }] }, false],
    [{ triggers: [{ kind: 'schedule', every: '24h', cron: '0 9 * * *', timezone: 'UTC' }] }, false],
    [{ triggers: [{ kind: 'threshold', count: 20, per: 'subcategory', window_days: 7 }] }, true],
    [{ triggers: [{ kind: 'hourly' }] }, false],
    [{ budget: { max_scheduled_runs_per_day: 3 } }, false],
    [{ models: { orchestrator: null, worker: 'global.anthropic.claude-sonnet-5-5' } }, true],
    [{ models: { planner: null } }, false],
  ])('create_agent with %o → %s', (overrides, expected) => {
    expect(ok('create_agent', { ...validArgs('create_agent'), ...overrides })).toBe(expected);
  });

  it('create_agent refuses arguments without a scope', () => {
    expect(ok('create_agent', { name: 'No scope' })).toBe(false);
  });

  it('update_agent refuses empty updates and unknown keys', () => {
    expect(ok('update_agent', { agent_id: 'a', updates: {}, change_summary: 'c' })).toBe(false);
    expect(ok('update_agent', { agent_id: 'a', updates: { owner_sub: 'x' }, change_summary: 'c' })).toBe(false);
    expect(ok('update_agent', { agent_id: 'a', updates: { enabled: true }, change_summary: 'c' })).toBe(false);
  });

  const tooManyNodes = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, type: 'custom_llm', position: { x: 0, y: i }, data: { title: 't' } }));

  // Workflow writes take a complete, bounded definition.
  it.each<[string, unknown, boolean]>([
    ['the sample', SAMPLE_WORKFLOW, true],
    ['an unknown schema version', { ...SAMPLE_WORKFLOW, schema: 'voc-workflow/2' }, false],
    ['no nodes', { ...SAMPLE_WORKFLOW, nodes: [] }, false],
    ['a partial definition', { name: 'partial', nodes: SAMPLE_WORKFLOW.nodes }, false],
    ['an unknown node type', { ...SAMPLE_WORKFLOW, nodes: [{ ...SAMPLE_WORKFLOW.nodes[0], type: 'shell' }] }, false],
    ['too many loop rounds', { ...SAMPLE_WORKFLOW, loops: [{ node_ids: ['n_prfaq'], until: 'review_pass', max_rounds: 6 }] }, false],
    ['61 nodes', { ...SAMPLE_WORKFLOW, nodes: tooManyNodes }, false],
  ])('create_workflow with %s → %s', (_label, definition, expected) => {
    expect(ok('create_workflow', { definition })).toBe(expected);
  });

  it('update_workflow refuses expected_revision 0', () => {
    expect(ok('update_workflow', { ...validArgs('update_workflow'), expected_revision: 0 })).toBe(false);
  });

  it('summarizes the revision step of update_workflow', () => {
    const result = tool('update_workflow').validate(validArgs('update_workflow'), admin);
    expect(result.ok ? tool('update_workflow').summarize(result.args) : '').toBe('Update workflow wf_1 (revision 2 → 3): Added a loop');
  });
});

describe('company write tools', () => {
  it('update_company_context needs a field, and "date" objectives need due', () => {
    expect(ok('update_company_context', {})).toBe(false);
    const objective = { title: 'Ship SSO', description: 'Enterprise', horizon: 'date' };
    expect(ok('update_company_context', { objectives: [objective] })).toBe(false);
    expect(ok('update_company_context', { objectives: [{ ...objective, due: '2026-12-31' }] })).toBe(true);
    expect(ok('update_company_context', { vision: 'x'.repeat(20_001) })).toBe(false);
  });

  it('update_design_system accepts tokens + guidelines only (no integration tokens, no logo)', () => {
    const tokens = { colors: [{ name: 'primary', value: '#6C5CE7' }], typography: [{ role: 'body', family: 'Inter', weight: 400 }] };
    expect(ok('update_design_system', { tokens })).toBe(true);
    expect(ok('update_design_system', { figma_token: 'secret' })).toBe(false);
    expect(ok('update_design_system', { logo_url: 'https://x' })).toBe(false);
    expect(ok('update_design_system', { tokens: { colors: [] } })).toBe(false);
  });

  it('update_my_context bounds KPIs per objective', () => {
    const kpis = Array.from({ length: 11 }, (_, i) => ({ name: `k${i}`, target: i }));
    expect(ok('update_my_context', { objectives: [{ title: 't', description: 'd', kpis }] }, user)).toBe(false);
  });
});
