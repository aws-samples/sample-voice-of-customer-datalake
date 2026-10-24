/**
 * Per-project permissions through a WHOLE run, with the real tool catalogue
 * (fake Projects API): on a view-only project page the model never sees a
 * project write tool, and a project write aimed at a view-only project is
 * refused before any approval card.
 */
import { describe, it, expect } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import { CLIENT_TOOLS } from '../contract.js';
import { buildCatalogue } from '../tools/catalogue.js';
import { selectToolset } from '../tools/registry.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { nth } from '../../lib/nth-fixtures.js';
import { runBody, type ScriptedTurn } from './__fixtures__/fakes.js';
import { finished, harness, lastUserContent, run, silenceConsole, type Harness } from './__fixtures__/harness.js';

const VIEWER_ACCESS = { role: 'viewer', can_view: true, can_edit: false, can_manage: false };
const OWNER_ACCESS = { role: 'owner', can_view: true, can_edit: true, can_manage: true };
const PROJECT_WRITES = new Set<string>(CLIENT_TOOLS.project);

function projectBody(projectId: string, access: unknown): Record<string, unknown> {
  return {
    project: { project_id: projectId, name: `Project ${projectId}`, visibility: 'private', access },
    personas: [],
    documents: [{ document_id: 'd1', title: 'PRD', doc_type: 'prd' }],
  };
}

/** A harness whose toolset is the real catalogue over a fake Projects API. */
function catalogueHarness(turns: ScriptedTurn[], routes: Record<string, unknown>): Harness {
  const catalogue = buildCatalogue(fakeDeps(routes));
  const h = harness(turns);
  h.deps.getToolset = (options) => selectToolset(catalogue, options);
  return h;
}

function projectPageBody(projectId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runBody({
    forwardedProps: { page: { kind: 'project', path: `/projects/${projectId}`, projectId } },
    messages: [{ id: 'u1', role: 'user', content: 'Rewrite the PRD summary' }],
    ...overrides,
  });
}

const UPDATE_DOCUMENT_INPUT = { document_id: 'd1', content: '# New PRD', change_summary: 'Rewrote the summary' };

/** Names Bedrock was offered on the first turn. */
function offeredTools(h: Harness): string[] {
  return (nth(h.calls, 0).tools ?? []).flatMap((tool) => (tool.toolSpec?.name === undefined ? [] : [tool.toolSpec.name]));
}

/** The expected names missing from `offered` (empty when all are present). */
function missingFrom(offered: readonly string[], expected: Iterable<string>): string[] {
  return [...expected].filter((name) => !offered.includes(name));
}

silenceConsole();

describe('runAssistant — view-only project page', () => {
  it('gives Bedrock no project write tool while keeping the project reads and packs', async () => {
    const h = catalogueHarness([{ text: 'You can only view this project.' }], {
      'GET /projects/proj_1': projectBody('proj_1', VIEWER_ACCESS),
    });
    const events = await run(projectPageBody('proj_1'), h);

    const offered = offeredTools(h);
    expect({
      writesOffered: offered.filter((name) => PROJECT_WRITES.has(name)),
      readsMissing: missingFrom(offered, ['get_project', 'get_documents', 'get_persona', 'create_project']),
    }).toStrictEqual({ writesOffered: [], readsMissing: [] });
    expect(events[1]).toMatchObject({ name: 'assistant.context', value: { packs: ['core', 'project'] } });
    expect(nth(h.calls, 0).systemSuffix).toContain('a project (id "proj_1")');
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('answers a project write the model attempts anyway with an error result and no approval', async () => {
    const h = catalogueHarness([
      { toolUses: [{ id: 'tu_w', name: 'update_document', input: UPDATE_DOCUMENT_INPUT }] },
      { text: 'I cannot change this project.' },
    ], { 'GET /projects/proj_1': projectBody('proj_1', VIEWER_ACCESS) });
    const events = await run(projectPageBody('proj_1'), h);

    expect(h.calls).toHaveLength(2);
    expect(lastUserContent(nth(h.calls, 1))).toStrictEqual([{
      toolResult: { toolUseId: 'tu_w', content: [{ text: 'Error: unknown tool "update_document".' }], status: 'error' },
    }]);
    expect(events.filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => e.toolCallId)).toStrictEqual(['tu_w']);
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('keeps the project write tools on a page whose project the caller can edit', async () => {
    const h = catalogueHarness([{ toolUses: [{ id: 'tu_w', name: 'update_document', input: UPDATE_DOCUMENT_INPUT }] }], {
      'GET /projects/proj_2': projectBody('proj_2', OWNER_ACCESS),
    });
    const events = await run(projectPageBody('proj_2'), h);

    expect(missingFrom(offeredTools(h), PROJECT_WRITES)).toStrictEqual([]);
    expect(finished(events).outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ toolCallId: 'tu_w', metadata: { toolName: 'update_document', projectId: 'proj_2' } }],
    });
  });
});

describe('runAssistant — project write against a project read as view-only', () => {
  const READ_PROJ_1 = { toolUses: [{ id: 'tu_r', name: 'get_project', input: { project_id: 'proj_1' } }] };

  /** On the editable proj_2 page, the model first reads the view-only proj_1, then `turns` follow. */
  async function runOnProj2AfterReadingProj1(turns: ScriptedTurn[]): Promise<{ h: Harness; events: BaseEvent[] }> {
    const h = catalogueHarness([READ_PROJ_1, ...turns], {
      'GET /projects/proj_2': projectBody('proj_2', OWNER_ACCESS),
      'GET /projects/proj_1': projectBody('proj_1', VIEWER_ACCESS),
    });
    return { h, events: await run(projectPageBody('proj_2'), h) };
  }

  it('refuses the write after a get_project read reported can_edit false, with no interrupt', async () => {
    const { h, events } = await runOnProj2AfterReadingProj1([
      { toolUses: [{ id: 'tu_w', name: 'update_document', input: { ...UPDATE_DOCUMENT_INPUT, project_id: 'proj_1' } }] },
      { text: 'That project is view-only for you.' },
    ]);

    expect({
      bedrockCalls: h.calls.length,
      toolResults: events.filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => e.toolCallId),
    }).toStrictEqual({ bedrockCalls: 3, toolResults: ['tu_r', 'tu_w'] });
    const refusal = nth(lastUserContent(nth(h.calls, 2)), 0);
    expect(refusal.toolResult).toMatchObject({ toolUseId: 'tu_w', status: 'error' });
    expect(refusal.toolResult?.content?.at(0)).toMatchObject({
      text: expect.stringContaining('not permitted — the signed-in user can only view project proj_1'),
    });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('still lets the same write through to approval on the editable project on screen', async () => {
    const { h, events } = await runOnProj2AfterReadingProj1([
      { toolUses: [{ id: 'tu_w', name: 'update_document', input: UPDATE_DOCUMENT_INPUT }] },
    ]);

    expect(h.calls).toHaveLength(2);
    expect(finished(events).outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ toolCallId: 'tu_w', metadata: { projectId: 'proj_2' } }],
    });
  });
});
