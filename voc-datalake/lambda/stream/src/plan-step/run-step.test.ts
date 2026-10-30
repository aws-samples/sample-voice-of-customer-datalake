import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { canonicalWriteFingerprint } from '../assistant/plan/fingerprint.js';
import { THINK_DEFAULT_OUTPUT } from '../assistant/plan/outputs.js';
import { buildCatalogue } from '../assistant/tools/catalogue.js';
import { AssistantToolError } from '../assistant/tools/errors.js';
import type { ApiCall } from '../assistant/tools/internal-api.js';
import { fakeDeps } from '../assistant/tools/test-fixtures.js';
import type { PlanStepDeps } from './deps.js';
import { MAX_FREE_FIELD_CHARS, cleanFreeText } from './free-fields.js';
import { matchesDefinition } from './matching.js';
import { runPlanStep } from './run-step.js';
import { thinkTools } from './think.js';

const PLAN = 'pl_0123456789ab';
const USER_CLAIMS = { sub: 'sub-1', 'cognito:username': 'jane', 'cognito:groups': 'users', 'voc:acting_subject': 'sub-1', 'voc:principal': `plan:${PLAN}` };
const ADMIN_CLAIMS = { ...USER_CLAIMS, 'cognito:groups': 'admins,users' };

function text(answer: string, stopReason: ConverseCommandOutput['stopReason'] = 'end_turn'): ConverseCommandOutput {
  return { output: { message: { role: 'assistant', content: [{ text: answer }] } }, stopReason, $metadata: {}, metrics: undefined, usage: undefined };
}

interface Harness {
  deps: PlanStepDeps;
  calls: { call: ApiCall; claims: Record<string, unknown> }[];
  commands: ConverseCommand[];
}

function harness(routes: Record<string, unknown> = {}, answers: ConverseCommandOutput[] = []): Harness {
  const calls: Harness['calls'] = [];
  const commands: ConverseCommand[] = [];
  const queue = [...answers];
  return {
    calls,
    commands,
    deps: {
      invoke: (call, claims) => {
        calls.push({ call, claims: { ...claims } });
        const answer = routes[`${call.method} ${call.path}`];
        if (answer instanceof Error) return Promise.reject(answer);
        return answer === undefined ? Promise.reject(new AssistantToolError('not_found', 'Not found.')) : Promise.resolve(answer);
      },
      catalogue: buildCatalogue(fakeDeps()),
      converse: (command) => {
        commands.push(command);
        const next = queue.shift();
        return next === undefined ? Promise.reject(new Error('no answer queued')) : Promise.resolve(next);
      },
      resolveModel: () => Promise.resolve('global.anthropic.claude-sonnet-5-5'),
    },
  };
}

const writeStep = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 's2', pack: 'core', kind: 'write', title: 'Create the project', write: { tool, args }, produces: ['project_id'], ...extra,
});
const event = (step: unknown, extra: Record<string, unknown> = {}) => ({ plan_id: PLAN, step, resolved: {}, think_outputs: {}, claims: USER_CLAIMS, ...extra });
const CREATED = { 'POST /projects': { success: true, project: { project_id: 'proj_9' } } };

describe('write steps that match their definition', () => {
  it('run the declared write as the approver and report its declared outputs', async () => {
    const h = harness(CREATED);
    const result = await runPlanStep(event(writeStep('create_project', { name: 'Ancillaries' })), h.deps);
    expect(result).toStrictEqual({
      status: 'done', outputs: { project_id: 'proj_9' }, model_calls: 0, fingerprint: canonicalWriteFingerprint('create_project', { name: 'Ancillaries' }),
    });
    expect(h.calls[0]?.call).toMatchObject({ fn: 'projects', method: 'POST', path: '/projects', body: { name: 'Ancillaries' } });
    expect(h.calls[0]?.claims).toStrictEqual(USER_CLAIMS);
  });

  it('fill a reference from the earlier step\u2019s recorded output', async () => {
    const h = harness({ 'POST /projects/proj_9/personas/generate': { success: true, job_id: 'job_1' } });
    const step = { id: 's3', pack: 'project', kind: 'write', title: 'Personas', after: ['s2'], write: { tool: 'generate_personas', args: { project_id: '{{s2.project_id}}', persona_count: 4 } }, produces: ['job_id'] };
    const result = await runPlanStep(event(step, { resolved: { 's2.project_id': 'proj_9' } }), h.deps);
    expect(result).toMatchObject({ status: 'done', outputs: { job_id: 'job_1' }, model_calls: 0 });
    expect(h.calls[0]?.call.body).toMatchObject({ persona_count: 4, days: 30 });
  });

  it('fail when a referenced output was never recorded', async () => {
    const step = { id: 's3', pack: 'project', kind: 'write', title: 'Personas', after: ['s2'], write: { tool: 'generate_personas', args: { project_id: '{{s2.project_id}}', persona_count: 4 } } };
    expect(await runPlanStep(event(step), harness().deps)).toMatchObject({ status: 'failed', error: expect.stringContaining('s2.project_id') });
  });

  it('write a {{free}} field with one bounded model call, using only the declared field', async () => {
    const h = harness(CREATED, [text('Sure: {"description": "Hotels\\u0007, cars and eSIM.", "name": "Hijacked"}')]);
    const result = await runPlanStep(event(writeStep('create_project', { name: 'Ancillaries', description: '{{free}}' }), { think_outputs: { 's1.summary': 'Reviews ask for bundles.' } }), h.deps);
    expect(result).toMatchObject({ status: 'done', model_calls: 1 });
    expect(h.calls[0]?.call.body).toStrictEqual({ name: 'Ancillaries', description: 'Hotels , cars and eSIM.' });
    expect(h.commands[0]?.input.inferenceConfig?.maxTokens).toBe(3000);
  });

  it('asks for approval when the written free text breaks the tool\u2019s own bound', async () => {
    const h = harness(CREATED, [text(JSON.stringify({ description: 'x'.repeat(9000) }))]);
    const result = await runPlanStep(event(writeStep('create_project', { name: 'A', description: '{{free}}' })), h.deps);
    expect(result).toMatchObject({ status: 'needs_approval', pending: { tool: 'create_project', reason: expect.stringContaining('validation') } });
    expect(h.calls).toStrictEqual([]);
  });

  it('use a stable edit id per step, so a retried document edit is the same edit', async () => {
    const h = harness({ 'PUT /projects/p1/documents/d1': { document: { document_id: 'd2' } } });
    const step = { id: 's4', pack: 'project', kind: 'write', title: 'Edit', write: { tool: 'update_document', args: { project_id: 'p1', document_id: 'd1', content: '# New', change_summary: 'Rewrite' } } };
    await runPlanStep(event(step), h.deps);
    expect(h.calls[0]?.call.body).toMatchObject({ edit_id: `${PLAN}-s4` });
  });
});

describe('write steps that need a card', () => {
  it('asks again for a never-pre-approvable tool even when the plan lists it', async () => {
    const h = harness();
    const step = { id: 's1', pack: 'project', kind: 'write', title: 'Delete', write: { tool: 'delete_document', args: { project_id: 'p1', document_id: 'd1', reason: 'Old' } } };
    const result = await runPlanStep(event(step), h.deps);
    expect(result).toMatchObject({ status: 'needs_approval', pending: { tool: 'delete_document', args: { project_id: 'p1', document_id: 'd1', reason: 'Old' } } });
    expect(h.calls).toStrictEqual([]);
  });

  it('asks when a literal no longer matches what was approved (a literal the schema rewrites)', async () => {
    const h = harness(CREATED);
    expect(await runPlanStep(event(writeStep('create_project', { name: '  Ancillaries ' })), h.deps)).toMatchObject({ status: 'needs_approval', pending: { reason: expect.stringContaining('differs') } });
    expect(h.calls).toStrictEqual([]);
  });

  it('asks again when the approved pending write\u2019s fingerprint does not match its arguments', async () => {
    const h = harness(CREATED);
    const approved = { tool: 'delete_document', args: { project_id: 'p1', document_id: 'OTHER', reason: 'Old' }, fingerprint: canonicalWriteFingerprint('delete_document', { project_id: 'p1', document_id: 'd1', reason: 'Old' }) };
    const step = { id: 's1', pack: 'project', kind: 'write', title: 'Delete', write: { tool: 'delete_document', args: { project_id: 'p1', document_id: 'd1', reason: 'Old' } } };
    expect(await runPlanStep(event(step, { approved_pending: approved }), h.deps)).toMatchObject({ status: 'needs_approval' });
    expect(h.calls).toStrictEqual([]);
  });

  it('runs exactly the approved pending write when its fingerprint matches', async () => {
    const args = { project_id: 'p1', document_id: 'd1', reason: 'Old' };
    const h = harness({ 'DELETE /projects/p1/documents/d1': { success: true } });
    const step = { id: 's1', pack: 'project', kind: 'write', title: 'Delete', write: { tool: 'delete_document', args } };
    const result = await runPlanStep(event(step, { approved_pending: { tool: 'delete_document', args, fingerprint: canonicalWriteFingerprint('delete_document', args) } }), h.deps);
    expect(result).toMatchObject({ status: 'done', outputs: {}, model_calls: 0 });
    expect(h.calls.map((c) => c.call.method)).toStrictEqual(['DELETE']);
  });

  it('asks again when the schema would rewrite the approved arguments (the run would not be the approved write)', async () => {
    const args = { name: '  Edited by the user ' };
    const h = harness(CREATED);
    const result = await runPlanStep(event(writeStep('create_project', { name: 'Ancillaries' }), { approved_pending: { tool: 'create_project', args, fingerprint: canonicalWriteFingerprint('create_project', args) } }), h.deps);
    expect(result).toMatchObject({ status: 'needs_approval' });
    expect(h.calls).toStrictEqual([]);
  });

  it('reports the approved fingerprint for the approved write it ran', async () => {
    const args = { name: 'Edited by the user' };
    const result = await runPlanStep(event(writeStep('create_project', { name: 'Ancillaries' }), { approved_pending: { tool: 'create_project', args, fingerprint: canonicalWriteFingerprint('create_project', args) } }), harness(CREATED).deps);
    expect(result).toMatchObject({ status: 'done', fingerprint: canonicalWriteFingerprint('create_project', args) });
  });

  it('runs an approved create_project whose fingerprint matches', async () => {
    const args = { name: 'Edited by the user' };
    const h = harness(CREATED);
    const result = await runPlanStep(event(writeStep('create_project', { name: 'Ancillaries' }), { approved_pending: { tool: 'create_project', args, fingerprint: canonicalWriteFingerprint('create_project', args) } }), h.deps);
    expect(result).toMatchObject({ status: 'done', outputs: { project_id: 'proj_9' }, model_calls: 0 });
    expect(h.calls[0]?.call.body).toStrictEqual(args);
  });
});

describe('matchesDefinition', () => {
  const declared = { project_id: 'proj_9', name: 'A', description: '{{free}}' };

  it('accepts the declared literals with the free field written', () => {
    expect(matchesDefinition(declared, { project_id: 'proj_9', name: 'A', description: 'Text' })).toBe(true);
  });

  it.each([
    ['a changed literal', { project_id: 'proj_9', name: 'B', description: 'Text' }],
    ['a changed target', { project_id: 'proj_X', name: 'A', description: 'Text' }],
    ['an extra key', { project_id: 'proj_9', name: 'A', description: 'Text', visibility: 'public' }],
    ['an unfilled free field', { project_id: 'proj_9', name: 'A' }],
  ])('refuses %s', (_label, final) => {
    expect(matchesDefinition(declared, final)).toBe(false);
  });
});

describe('free text', () => {
  it('strips control characters, keeps newlines and caps the length', () => {
    expect(cleanFreeText(' a\u0000b\nc ')).toBe('a b\nc');
    expect(cleanFreeText('x'.repeat(MAX_FREE_FIELD_CHARS + 50))).toHaveLength(MAX_FREE_FIELD_CHARS);
  });
});

describe('preconditions, fallbacks and admin gating', () => {
  const connector = { id: 's1', pack: 'scrapers', kind: 'write', title: 'Connect', write: { tool: 'create_app_connector', args: { source: 'app_reviews_ios', app_name: 'ExampleAir iOS', app_id: '1234567890' } }, produces: ['app_config_id'] };

  it('refuses an admin-only write when the claims carry no admins group', async () => {
    const h = harness();
    expect(await runPlanStep(event(connector), h.deps)).toMatchObject({ status: 'failed', error: expect.stringContaining('administrator') });
    expect(h.calls).toStrictEqual([]);
  });

  it('fails without writing when the app is already configured', async () => {
    const h = harness({ 'GET /integrations/app_reviews_ios/apps': { apps: [{ app_name: 'ExampleAir iOS', app_id: '1234567890' }] } });
    expect(await runPlanStep(event(connector, { claims: ADMIN_CLAIMS }), h.deps)).toMatchObject({ status: 'failed', error: expect.stringContaining('already configured') });
    expect(h.calls.map((c) => c.call.method)).toStrictEqual(['GET']);
  });

  it('creates the connector and reports its config id', async () => {
    const h = harness({ 'GET /integrations/app_reviews_ios/apps': { apps: [] }, 'POST /integrations/app_reviews_ios/apps': { success: true, app: { id: 'app_7' } } });
    expect(await runPlanStep(event(connector, { claims: ADMIN_CLAIMS }), h.deps)).toMatchObject({ status: 'done', outputs: { app_config_id: 'app_7' }, model_calls: 0 });
  });

  it('files a refused company-memory edit as a proposal', async () => {
    const h = harness({ 'PUT /memory/mem_1': new AssistantToolError('not_permitted', 'Not permitted.'), 'POST /memory': { memory: { memory_id: 'mem_2', status: 'proposed' } } });
    const step = { id: 's1', pack: 'core', kind: 'write', title: 'Memory', write: { tool: 'update_company_memory', args: { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', supporters: 2, reason: 'Changed' } } };
    expect(await runPlanStep(event(step), h.deps)).toMatchObject({ status: 'done', outputs: { memory_id: 'mem_2' }, model_calls: 0 });
  });

  it('refuses a plan control tool, an invalid event and a wait step', async () => {
    const h = harness();
    expect(await runPlanStep(event(writeStep('cancel_plan', { plan_id: PLAN })), h.deps)).toMatchObject({ status: 'failed' });
    expect(await runPlanStep({ plan_id: 'nope' }, h.deps)).toMatchObject({ status: 'failed', error: 'The plan step event is invalid.' });
    expect(await runPlanStep(event({ id: 's1', pack: 'scrapers', kind: 'wait', title: 'Wait', wait: { for: 'source_run', source: 's3_import', execution_id: 'x' } }), h.deps)).toMatchObject({ status: 'failed' });
  });
});

describe('think steps', () => {
  const think = { id: 's4', pack: 'insights', kind: 'think', title: 'Problems', think: { brief: 'Summarise the main problems.' }, produces: ['summary'] };

  it('offer only read tools of the step\u2019s pack and core, without web search or plan tools', () => {
    const tools = thinkTools({ catalogue: buildCatalogue(fakeDeps()) }, 'insights', false);
    expect(tools.every((tool) => ['insights', 'core'].includes(tool.pack))).toBe(true);
    expect(tools.map((tool) => tool.name).filter((name) => ['web_search', 'plan_lookup', 'create_project', 'get_source_run'].includes(name))).toStrictEqual([]);
  });

  it('never offer the user directory, even to an admin approver in the settings pack', () => {
    const tools = thinkTools({ catalogue: buildCatalogue(fakeDeps()) }, 'settings', true).map((tool) => tool.name);
    expect(tools).toContain('get_categories_config');
    expect(tools.filter((name) => ['list_users', 'get_user_access'].includes(name))).toStrictEqual([]);
  });

  it('answer a write the model attempts with an error and return the final text as the output', async () => {
    const toolUse: ConverseCommandOutput = { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'create_project', input: { name: 'x' } } }] } }, stopReason: 'tool_use', $metadata: {}, metrics: undefined, usage: undefined };
    const h = harness({}, [toolUse, text('Late flights and refunds.')]);
    const result = await runPlanStep(event(think), h.deps);
    expect(result).toStrictEqual({ status: 'done', outputs: { summary: 'Late flights and refunds.' }, model_calls: 2 });
    expect(JSON.stringify(h.commands[1]?.input.messages)).toContain('not available in this step');
    expect(h.calls).toStrictEqual([]);
  });

  it('key the answer of a step without produces under the contract default the conductor stores', async () => {
    const undeclared = { id: 's1', pack: 'project', kind: 'think', title: 'Personas', think: { brief: 'Summarise the personas.' } };
    const result = await runPlanStep(event(undeclared), harness({}, [text('Two personas.')]).deps);
    expect(result).toStrictEqual({ status: 'done', outputs: { [THINK_DEFAULT_OUTPUT]: 'Two personas.' }, model_calls: 1 });
  });

  it('never sends a write tool spec to the model', async () => {
    const h = harness({}, [text('Done.')]);
    await runPlanStep(event(think), h.deps);
    const names = (h.commands[0]?.input.toolConfig?.tools ?? []).map((tool) => tool.toolSpec?.name);
    expect(names).toContain('list_feedback');
    expect(names.filter((name) => ['create_project', 'set_feedback_category', 'propose_plan'].includes(name ?? ''))).toStrictEqual([]);
  });

  it('run on Haiku 5.5 when the conductor\u2019s approver claims carry the e2e group, else on the resolved model', async () => {
    const e2e = harness({}, [text('Done.')]);
    await runPlanStep(event(think, { claims: { ...USER_CLAIMS, 'cognito:groups': 'users,e2e' } }), e2e.deps);
    expect(e2e.commands[0]?.input.modelId).toBe('global.anthropic.claude-haiku-5-5');
    const regular = harness({}, [text('Done.')]);
    await runPlanStep(event(think), regular.deps);
    expect(regular.commands[0]?.input.modelId).toBe('global.anthropic.claude-sonnet-5-5');
  });
});
