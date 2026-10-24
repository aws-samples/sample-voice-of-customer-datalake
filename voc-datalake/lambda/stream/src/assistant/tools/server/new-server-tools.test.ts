import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { SAMPLE_WORKFLOW } from '../client/new-tools-fixtures.js';
import { parseRecalled, scrubMemoryResponse } from './memory-shape.js';

const MEMORY_ROW = {
  memory_id: 'mem_1', scope: 'company', status: 'active', kind: 'product', statement: 'Customers want SSO.',
  supporters: 4, embedding: 'AAAA', owner_sub: 'sub-x', sources: [{ type: 'session', ref: 'sess_1' }], pk: 'MEM#company',
};

describe('search_memory', () => {
  async function searchBothScopes() {
    const deps = fakeDeps({
      'GET /memory': { items: [MEMORY_ROW], next_cursor: 'c2' },
    });
    const result = await serverTool(deps, 'search_memory').execute({ query: 'SSO', kind: 'product' }, fakeContext());
    return { deps, result };
  }

  it('lists both scopes as the caller', async () => {
    const { deps } = await searchBothScopes();
    expect(deps.calls.map((c) => c.call.query?.scope)).toStrictEqual(['company', 'personal']);
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'memory', method: 'GET', query: { q: 'SSO', kind: 'product' } });
    expect(deps.calls[0]?.sub).toBe('user-sub');
  });

  it('returns the statements and the cursor flag', async () => {
    const { result } = await searchBothScopes();
    expect(result.content).toContain('Customers want SSO.');
    expect(result.content).toContain('"more":true');
  });

  it.each(['AAAA', 'sub-x', 'sess_1', 'MEM#company'])('never passes the embedding, owner or source ref %s', async (secret) => {
    const { result } = await searchBothScopes();
    expect(result.content).not.toContain(secret);
  });

  it('reads one scope when asked', async () => {
    const deps = fakeDeps({ 'GET /memory': { items: [] } });
    await serverTool(deps, 'search_memory').execute({ scope: 'personal' }, fakeContext());
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]?.call.query?.scope).toBe('personal');
  });

  it('mode "conflicts" calls conflict-check with the statement and prompts the N-people question', async () => {
    const deps = fakeDeps({ 'GET /memory/conflict-check': { conflicts: [MEMORY_ROW] } });
    const result = await serverTool(deps, 'search_memory')
      .execute({ mode: 'conflicts', query: 'Customers do not want SSO.' }, fakeContext());
    expect(deps.calls[0]?.call.query).toStrictEqual({ statement: 'Customers do not want SSO.' });
    expect(result.content).toContain('"supporters":4');
    expect(result.content).toContain('people said');
  });

  it('mode "conflicts" needs a statement', async () => {
    await expect(serverTool(fakeDeps(), 'search_memory').execute({ mode: 'conflicts' }, fakeContext()))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('get_memory_review', () => {
  it('scrubs private keys at any depth', async () => {
    const deps = fakeDeps({ 'GET /memory/review': { items: [{ kind: 'conflict', memories: [MEMORY_ROW] }] } });
    const result = await serverTool(deps, 'get_memory_review').execute({}, fakeContext('memory'));
    expect(result.content).toContain('Customers want SSO.');
    expect(result.content).not.toContain('AAAA');
    expect(result.content).not.toContain('sub-x');
  });
});

describe('memory-shape', () => {
  it('parseRecalled keeps good rows, skips bad ones and defaults kind/supporters', () => {
    expect(parseRecalled({ items: [
      { memory_id: 'm1', scope: 'company', kind: 'weird', statement: 's', supporters: -1 },
      { memory_id: 'm2', scope: 'team', statement: 's' },
      'junk',
    ] })).toStrictEqual([{ memory_id: 'm1', scope: 'company', kind: 'other', statement: 's', supporters: 1 }]);
    expect(parseRecalled(null)).toStrictEqual([]);
  });

  it('scrubMemoryResponse stops at its depth bound', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(JSON.stringify(scrubMemoryResponse(deep))).toContain('[…]');
  });
});

describe('agents tools', () => {
  const AGENT = { agent_id: 'ag_7', name: 'Checkout', workflow_id: 'wf_9', owner_sub: 'sub-owner', instructions: 'Go' };

  it('list_agents and get_agent read the agents Lambda as the caller; get_agent defaults to the agent on screen', async () => {
    const deps = fakeDeps({ 'GET /agents': { agents: [AGENT] }, 'GET /agents/ag_7': { agent: AGENT } });
    const page = fakeContext('agent', { agentId: 'ag_7' });
    const list = await serverTool(deps, 'list_agents').execute({}, page);
    const one = await serverTool(deps, 'get_agent').execute({}, page);
    expect(list.content).toContain('"count":1');
    expect(one.content).toContain('"instructions":"Go"');
    expect(one.content).not.toContain('sub-owner');
    expect(deps.calls.every((c) => c.call.fn === 'agents' && c.call.method === 'GET')).toBe(true);
  });

  it('get_workflow resolves the workflow of the agent on screen', async () => {
    const deps = fakeDeps({
      'GET /agents/ag_7': AGENT,
      'GET /workflows/wf_9': { workflow_id: 'wf_9', revision: 3, definition: SAMPLE_WORKFLOW },
    });
    const result = await serverTool(deps, 'get_workflow').execute({}, fakeContext('agent', { agentId: 'ag_7' }));
    expect(deps.calls.map((c) => c.call.path)).toStrictEqual(['/agents/ag_7', '/workflows/wf_9']);
    expect(result.content).toContain('"revision":3');
    await expect(serverTool(deps, 'get_workflow').execute({}, fakeContext('agents')))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('get_agent_run reads the run and, on request, its events', async () => {
    const deps = fakeDeps({
      'GET /agents/ag_7/runs/ar_1': { run: { run_id: 'ar_1', status: 'running' } },
      'GET /agents/ag_7/runs/ar_1/events': { events: [{ seq: 1, kind: 'node_started', node_id: 'n_agg', summary: 'Go' }] },
    });
    const result = await serverTool(deps, 'get_agent_run')
      .execute({ run_id: 'ar_1', include_events: true, after: 0 }, fakeContext('agent', { agentId: 'ag_7' }));
    expect(result.content).toContain('"status":"running"');
    expect(result.content).toContain('node_started');
    expect(deps.calls[1]?.call.query).toStrictEqual({ after: 0 });
  });

  it('list_agent_runs caps the limit', async () => {
    const deps = fakeDeps({ 'GET /agents/ag_7/runs': { runs: [{ run_id: 'ar_1' }, { run_id: 'ar_2' }] } });
    const result = await serverTool(deps, 'list_agent_runs').execute({ agent_id: 'ag_7', limit: 1 }, fakeContext());
    expect(result.content).toContain('"returned":1');
    await expect(serverTool(deps, 'list_agent_runs').execute({ agent_id: 'ag_7', limit: 51 }, fakeContext()))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('validate_workflow reports shape errors locally and posts a well-shaped definition to the Lambda', async () => {
    const deps = fakeDeps({ 'POST /workflows/validate': { valid: false, errors: [{ node_id: 'n_end', message: 'unreachable' }] } });
    const tool = serverTool(deps, 'validate_workflow');
    const local = await tool.execute({ definition: { ...SAMPLE_WORKFLOW, nodes: [] } }, fakeContext());
    expect(local.content).toContain('"valid":false');
    expect(deps.calls).toHaveLength(0);
    const remote = await tool.execute({ definition: SAMPLE_WORKFLOW }, fakeContext());
    expect(remote.content).toContain('unreachable');
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'agents', method: 'POST', resource: '/workflows/validate' });
  });
});

describe('company tools', () => {
  it.each([
    ['get_company_context', '/settings/company-context'],
    ['get_my_context', '/settings/my-context'],
    ['get_design_system', '/settings/design-system'],
  ])('%s reads %s from the settings Lambda', async (name, path) => {
    const deps = fakeDeps({ [`GET ${path}`]: { ok: true } });
    await serverTool(deps, name).execute({}, fakeContext('settings'));
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'settings', method: 'GET', path });
  });

  it('get_design_system reduces integrations to connected flags', async () => {
    const deps = fakeDeps({
      'GET /settings/design-system': { guidelines: 'g', integrations: { figma: true, github: 'ghp_secret', figma_token: 'x' } },
    });
    const result = await serverTool(deps, 'get_design_system').execute({}, fakeContext('settings'));
    expect(result.content).toContain('"integrations":{"figma":true,"github":false}');
    expect(result.content).not.toContain('ghp_secret');
  });
});
