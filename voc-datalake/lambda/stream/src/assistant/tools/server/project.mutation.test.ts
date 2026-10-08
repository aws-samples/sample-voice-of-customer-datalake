/**
 * Mutation pins for the `project` pack server tools.
 *
 * The Stryker run found what the behaviour suite could not see: the exact
 * Bedrock specs, the rendered get_documents text (header defaults, the empty-
 * content line, the separator, the per-document share of the 40,000-character
 * budget), research notes (last ten, allowlisted keys, clipped), get_product_context
 * (never called at all), each job field and the `result` null/undefined rule,
 * the job limit's bounds and default, and the strict inputs.
 */
import { describe, expect, it } from 'vitest';
import type { ServerToolDefinition } from '../../types.js';
import { fakeContext, fakeDeps, type FakeDeps } from '../test-fixtures.js';
import { createProjectServerTools } from './project.js';

const PROJECT_ID = { type: 'string', maxLength: 128, description: 'Project id; omit to use the project on screen.' };
/** A fresh run context on project proj_1 (each has its own access ledger). */
const onProject = () => fakeContext('project', { projectId: 'proj_1' });

function tool(deps: FakeDeps, name: string): ServerToolDefinition {
  const found = createProjectServerTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new TypeError(`no tool ${name}`);
  return found;
}

function inputSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { json: { type: 'object', properties, required, additionalProperties: false } };
}

function chatContext(documents: unknown[], access?: unknown) {
  return { 'POST /projects/proj_1/chat-context': { project: { name: 'Checkout' }, personas: [], documents, access } };
}

describe('the project tool definitions', () => {
  it('lists the five project-pack tools in order', () => {
    const tools = createProjectServerTools(fakeDeps());
    expect(tools.map((t) => [t.kind, t.name, t.pack])).toStrictEqual([
      ['server', 'get_documents', 'project'],
      ['server', 'get_persona', 'project'],
      ['server', 'get_product_context', 'project'],
      ['server', 'list_project_jobs', 'project'],
      ['server', 'consult_personas', 'project'],
    ]);
  });

  it.each([
    ['get_documents', 'Read the full text of up to 5 project documents (PRDs, PR/FAQs, research, custom). '
      + 'Get the ids from get_project. Read a document before proposing changes to it.', inputSchema({
      project_id: PROJECT_ID,
      document_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: 'Document ids to read.' },
    }, ['document_ids'])],
    ['get_persona', 'Full profile of one project persona: identity, goals, pain points, behaviours, context, quotes, scenario and the '
      + 'latest research notes. Get persona ids from get_project.', inputSchema({
      project_id: PROJECT_ID,
      persona_id: { type: 'string', maxLength: 128, description: 'Persona id.' },
    }, ['persona_id'])],
    ['get_product_context', 'The project\u2019s product context (product name, one-liner, target users, problem, key features, '
      + 'differentiators, limitations, non-goals, success metrics, notes, lifecycle state). Empty strings = not filled in.',
    inputSchema({ project_id: PROJECT_ID })],
    ['list_project_jobs', 'Recent background jobs of the project (research, persona generation, document generation, merges), newest '
      + 'first, with status and progress. Use it to report on work started after an approval.', inputSchema({
      project_id: PROJECT_ID,
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max jobs (default 20).' },
    })],
  ])('%s has its exact spec', (name, description, schema) => {
    expect(tool(fakeDeps(), name).spec).toStrictEqual({ toolSpec: { name, description, inputSchema: schema } });
  });

  it.each([
    ['get_documents', { document_ids: ['d1'] }],
    ['get_persona', { persona_id: 'p1' }],
    ['get_product_context', {}],
    ['list_project_jobs', {}],
  ])('%s names project_id when neither the model nor the page gives one', async (name, input) => {
    await expect(tool(fakeDeps(), name).execute(input, fakeContext())).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Missing project_id: none was given and the current page has no default.',
    });
  });

  it.each([
    ['get_product_context', { extra: 1 }],
    ['list_project_jobs', { limit: 5, extra: 1 }],
    ['list_project_jobs', { limit: 0 }],
    ['list_project_jobs', { limit: 51 }],
    ['get_documents', { document_ids: [] }],
    ['get_documents', { document_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ])('%s refuses %j', async (name, input) => {
    const deps = fakeDeps();
    await expect(tool(deps, name).execute(input, onProject())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });
});

describe('get_documents renders each requested document once', () => {
  it('renders header defaults, the empty-content line, a sort-key prototype and the separator', async () => {
    const deps = fakeDeps(chatContext([
      { sk: 'DOC#d0', document_id: 'd0' },
      { sk: 'PROTOTYPE#p', document_id: 'p', title: 'Proto', document_type: 'custom' },
      { sk: 'PRD#d1', document_id: 'd1', title: 'Spec', document_type: 'prd', content: 'Body' },
    ], { role: 'viewer', can_edit: false, can_manage: false }));
    const ctx = onProject();
    const result = await tool(deps, 'get_documents').execute({ document_ids: ['d0', 'p', 'd1', 'd0'] }, ctx);
    expect(deps.calls[0]?.call.body).toStrictEqual({ selected_document_ids: ['d0', 'p', 'd1'] });
    expect(result).toStrictEqual({
      content: 'Project "Checkout" (proj_1):\n\n'
        + '## Untitled (DOC) [ID: d0]\n(No text content.)\n\n---\n\n'
        + '## Proto (CUSTOM) [ID: p]\nPrototype HTML is not available as text.\n\n---\n\n'
        + '## Spec (PRD) [ID: d1]\n\nBody',
    });
    expect(ctx.projectAccess.get('proj_1')).toStrictEqual({ role: 'viewer', can_edit: false, can_manage: false });
  });

  it('splits the 40,000-character budget evenly between the requested documents', async () => {
    const deps = fakeDeps(chatContext([
      { document_id: 'd1', content: 'a'.repeat(20_000) },
      { document_id: 'd2', content: 'b'.repeat(20_001) },
    ]));
    const result = await tool(deps, 'get_documents').execute({ document_ids: ['d1', 'd2'] }, onProject());
    expect(result.content).toContain(`[ID: d1]\n\n${'a'.repeat(20_000)}\n\n---\n\n`);
    expect(result.content).toContain('[TRUNCATED: showing the first 20000 of 20001 characters.');
  });
});

describe('get_persona', () => {
  const NOTES = [
    'plain note',
    ...Array.from({ length: 10 }, (_, i) => ({ note_id: `n${i}`, text: `t${i}`, author: 'ana', created_at: '2026-01-01', pk: 'x' })),
    { note_id: 'long', text: 'x'.repeat(601) },
  ];

  it('returns the last ten research notes with allowlisted, clipped fields and records the access', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1': {
        project: { access: { role: 'editor', can_edit: true, can_manage: false } },
        personas: [{ persona_id: 'p2' }, { persona_id: 'p1', research_notes: NOTES }],
      },
    });
    const ctx = onProject();
    const result = await tool(deps, 'get_persona').execute({ persona_id: 'p1' }, ctx);
    expect(JSON.parse(result.content)).toStrictEqual({
      persona_id: 'p1',
      research_notes: [
        ...Array.from({ length: 9 }, (_, i) => ({ note_id: `n${i + 1}`, text: `t${i + 1}`, author: 'ana', created_at: '2026-01-01' })),
        { note_id: 'long', text: `${'x'.repeat(600)}…` },
      ],
    });
    expect(ctx.projectAccess.get('proj_1')).toStrictEqual({ role: 'editor', can_edit: true, can_manage: false });
  });

  it('keeps a non-record note as it is and a non-list notes field as a clipped value', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1': {
        project: {},
        personas: [{ persona_id: 'p1', research_notes: ['only note'] }, { persona_id: 'p3', research_notes: 'y'.repeat(2001) }],
      },
    });
    const persona = tool(deps, 'get_persona');
    await expect(persona.execute({ persona_id: 'p1' }, onProject()))
      .resolves.toStrictEqual({ content: '{"persona_id":"p1","research_notes":["only note"]}' });
    await expect(persona.execute({ persona_id: 'p3' }, onProject()))
      .resolves.toStrictEqual({ content: `{"persona_id":"p3","research_notes":"${'y'.repeat(2000)}…"}` });
  });

  it('names the persona and the project when the persona is not there', async () => {
    const deps = fakeDeps({ 'GET /projects/proj_1': { project: {}, personas: [] } });
    await expect(tool(deps, 'get_persona').execute({ persona_id: 'p9' }, onProject()))
      .rejects.toMatchObject({ code: 'not_found', message: 'Persona p9 is not in project proj_1.' });
  });
});

describe('get_product_context', () => {
  it('reads /projects/{id}/product-context of the given project as the caller and returns the context', async () => {
    const deps = fakeDeps({ 'GET /projects/proj_1/product-context': { context: { product_name: 'Shop', notes: '' }, other: 1 } });
    const result = await tool(deps, 'get_product_context').execute({ project_id: 'proj_1' }, fakeContext());
    expect(deps.calls).toStrictEqual([{
      call: {
        fn: 'projects', method: 'GET', path: '/projects/proj_1/product-context',
        resource: '/projects/{project_id}/product-context', pathParameters: { project_id: 'proj_1' },
      },
      sub: 'user-sub',
    }]);
    expect(result).toStrictEqual({ content: '{"product_name":"Shop","notes":""}' });
  });

  it('reports an unreadable context as unavailable', async () => {
    const deps = fakeDeps({ 'GET /projects/proj_1/product-context': { context: 'none' } });
    await expect(tool(deps, 'get_product_context').execute({}, onProject()))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The product context could not be read.' });
  });
});

describe('list_project_jobs', () => {
  function jobs(count: number) {
    return Array.from({ length: count }, (_, i) => ({ job_id: `j${i}` }));
  }

  async function list(body: unknown, input: Record<string, unknown> = {}) {
    const deps = fakeDeps({ 'GET /projects/proj_1/jobs': body });
    const result = await tool(deps, 'list_project_jobs').execute(input, onProject());
    return JSON.parse(result.content);
  }

  it('keeps every summary field, drops unknown ones and adds a clipped result only when there is one', async () => {
    const full = {
      job_id: 'j1', job_type: 'research', status: 'failed', progress: 100, current_step: 'merge', created_at: 'c',
      updated_at: 'u', completed_at: 'd', error: 'boom', pk: 'PROJECT#proj_1', result: false,
    };
    expect(await list({ jobs: [full, { job_id: 'j2', result: null }, { job_id: 'j3' }, 'junk', { job_id: 'j4', result: 'z'.repeat(400) }] }))
      .toStrictEqual({
        count: 4,
        jobs: [
          {
            job_id: 'j1', job_type: 'research', status: 'failed', progress: 100, current_step: 'merge', created_at: 'c',
            updated_at: 'u', completed_at: 'd', error: 'boom', result: 'false',
          },
          { job_id: 'j2' },
          { job_id: 'j3' },
          { job_id: 'j4', result: `"${'z'.repeat(299)}…` },
        ],
      });
  });

  it.each([
    ['the default 20', {}, 21, 20],
    ['an explicit limit', { limit: 3 }, 5, 3],
    ['the lowest limit', { limit: 1 }, 2, 1],
    ['the highest limit', { limit: 50 }, 51, 50],
  ])('returns at most %s', async (_label, input, available, expected) => {
    expect(await list({ jobs: jobs(available) }, input)).toStrictEqual({ count: expected, jobs: jobs(expected) });
  });

  it('reads an unreadable job list as no jobs', async () => {
    expect(await list(null)).toStrictEqual({ count: 0, jobs: [] });
  });
});
