/**
 * Per-project permissions inside the assistant: project reads surface and
 * record the caller's access, and a view-only project loses its write tools.
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_TOOLS } from '../contract.js';
import type { ToolsetOptions } from '../types.js';
import { buildCatalogue } from './catalogue.js';
import { ProjectAccessLedger, parseProjectAccess } from './project-access.js';
import { selectToolset, toolGuidance, withoutProjectWrites } from './registry.js';
import { fakeContext, fakeDeps, serverTool } from './test-fixtures.js';

const VIEWER_ACCESS = { role: 'viewer', can_view: true, can_edit: false, can_manage: false };
const OWNER_ACCESS = { role: 'owner', can_view: true, can_edit: true, can_manage: true };

function projectBody(access: unknown): Record<string, unknown> {
  return {
    project: { project_id: 'proj_1', name: 'Checkout', visibility: 'private', access, members: [{ sub: 'x' }] },
    personas: [{ persona_id: 'p1', name: 'Pat' }],
    documents: [],
  };
}

describe('parseProjectAccess', () => {
  it('keeps role, can_edit and can_manage and drops everything else', () => {
    expect(parseProjectAccess({ ...VIEWER_ACCESS, extra: 'x' })).toStrictEqual({ role: 'viewer', can_edit: false, can_manage: false });
  });

  it('treats a missing or malformed role as none, and an unreadable record as unknown', () => {
    expect(parseProjectAccess({ role: 7, can_edit: true, can_manage: false })).toMatchObject({ role: null });
    expect(parseProjectAccess({ role: 'viewer' })).toBeUndefined();
    expect(parseProjectAccess('viewer')).toBeUndefined();
    expect(parseProjectAccess(undefined)).toBeUndefined();
  });
});

describe('ProjectAccessLedger', () => {
  it('is read-only only when a read reported can_edit false; the latest read wins', () => {
    const ledger = new ProjectAccessLedger();
    // isReadOnly after each step: unknown, no id, a viewer read, an unparseable read, an owner read.
    const trace = [ledger.isReadOnly('p1'), ledger.isReadOnly(undefined)];
    ledger.record('p1', parseProjectAccess(VIEWER_ACCESS));
    trace.push(ledger.isReadOnly('p1'));
    ledger.record('p1', undefined);
    trace.push(ledger.isReadOnly('p1'));
    ledger.record('p1', parseProjectAccess(OWNER_ACCESS));
    trace.push(ledger.isReadOnly('p1'));
    expect(trace).toStrictEqual([false, false, true, true, false]);
    expect(ledger.get('p1')).toStrictEqual({ role: 'owner', can_edit: true, can_manage: true });
  });
});

describe('project reads surface the caller access', () => {
  it('get_project puts the compact access first and records it for the run', async () => {
    const deps = fakeDeps({ 'GET /projects/proj_1': projectBody(VIEWER_ACCESS) });
    const ctx = fakeContext('project', { projectId: 'proj_1' });

    const result = await serverTool(deps, 'get_project').execute({}, ctx);
    const parsed: unknown = JSON.parse(result.content);

    expect(parsed).toStrictEqual({
      access: { role: 'viewer', can_edit: false, can_manage: false },
      project: { project_id: 'proj_1', name: 'Checkout', visibility: 'private' },
      personas: [{ persona_id: 'p1', name: 'Pat' }],
      documents: [],
    });
    expect(result.content.startsWith('{"access":')).toBe(true);
    expect(ctx.projectAccess.isReadOnly('proj_1')).toBe(true);
  });

  it('get_project omits access when the API did not report one', async () => {
    const deps = fakeDeps({ 'GET /projects/proj_1': projectBody(undefined) });
    const ctx = fakeContext('project', { projectId: 'proj_1' });
    const result = await serverTool(deps, 'get_project').execute({}, ctx);
    expect(result.content).not.toContain('access');
    expect(ctx.projectAccess.get('proj_1')).toBeUndefined();
  });

  it('get_persona and get_documents record the access their reads reported', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1': projectBody(VIEWER_ACCESS),
      'POST /projects/proj_2/chat-context': {
        project: { name: 'Other' }, personas: [], documents: [], access: VIEWER_ACCESS,
      },
    });
    const ctx = fakeContext('project', { projectId: 'proj_1' });
    await serverTool(deps, 'get_persona').execute({ persona_id: 'p1' }, ctx);
    await serverTool(deps, 'get_documents').execute({ project_id: 'proj_2', document_ids: ['d1'] }, ctx);
    expect(ctx.projectAccess.isReadOnly('proj_1')).toBe(true);
    expect(ctx.projectAccess.isReadOnly('proj_2')).toBe(true);
  });
});

describe('withoutProjectWrites', () => {
  const catalogue = buildCatalogue(fakeDeps());
  const options: ToolsetOptions = {
    page: { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' }, isAdmin: false, webSearch: false,
  };

  it('drops exactly the project pack client tools, keeping reads, packs and the canonical order', () => {
    const full = selectToolset(catalogue, options);
    const restricted = withoutProjectWrites(full);
    const projectWrites = new Set<string>(CLIENT_TOOLS.project);

    expect(restricted.tools.map((tool) => tool.name))
      .toStrictEqual(full.tools.map((tool) => tool.name).filter((name) => !projectWrites.has(name)));
    expect(restricted.packs).toStrictEqual(full.packs);
    expect({
      get_documents: restricted.byName.has('get_documents'),
      create_project: restricted.byName.has('create_project'),
      update_document: restricted.byName.has('update_document'),
    }).toStrictEqual({ get_documents: true, create_project: true, update_document: false });
    // The Bedrock specs follow the kept tools in order, and are rebuilt identically every time.
    expect({
      names: restricted.bedrockTools.map((tool) => tool.toolSpec?.name),
      stable: withoutProjectWrites(full).bedrockTools,
    }).toStrictEqual({ names: restricted.tools.map((tool) => tool.name), stable: restricted.bedrockTools });
  });

  it('returns a toolset without project writes unchanged', () => {
    const dashboard = selectToolset(catalogue, { ...options, page: { kind: 'dashboard', path: '/' } });
    expect(withoutProjectWrites(dashboard)).toBe(dashboard);
  });

  it('tells the model about access and that sharing is not an assistant action', () => {
    const guidance = toolGuidance(selectToolset(catalogue, options));
    expect(guidance).toContain('When can_edit is false they can only view it');
    expect(guidance).toContain('Sharing, members, visibility and ownership');
  });
});
