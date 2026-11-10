/**
 * The way of working with AI through a WHOLE run (docs/ways-of-working.md), with the real tool
 * catalogue over a fake Projects API:
 * - Human-driven with nothing unlocked: Bedrock is never offered `generate_document`, the system
 *   prompt carries the coaching section, and a PR/FAQ / PRD write the model attempts anyway is
 *   refused before any approval card (an update reads the target's stored type first);
 * - an unlock brings `generate_document` back; AI-driven adds no section;
 * - an unreadable mode reads as locked (fails closed).
 */
import { describe, expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import { buildCatalogue } from '../tools/catalogue.js';
import { selectToolset } from '../tools/registry.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { nth } from '../../lib/nth-fixtures.js';
import { runBody, type ScriptedTurn } from './__fixtures__/fakes.js';
import { finished, harness, lastUserContent, offeredTools, run, silenceConsole, type Harness } from './__fixtures__/harness.js';
import type { AiWritingPolicy, LoadAiWritingPolicy } from './ai-writing.js';

silenceConsole();

const OWNER_ACCESS = { role: 'owner', can_view: true, can_edit: true, can_manage: true };
const DOCUMENTS = [
  { sk: 'PRD#d_prd', document_id: 'd_prd', title: 'PRD', document_type: 'prd' },
  { sk: 'DOC#d_custom', document_id: 'd_custom', title: 'Notes', document_type: 'custom' },
];
const ROUTES = {
  'GET /projects/proj_1': {
    project: { project_id: 'proj_1', name: 'Project proj_1', visibility: 'private', access: OWNER_ACCESS },
    personas: [],
    documents: DOCUMENTS,
  },
  'POST /projects/proj_1/chat-context': { project: { name: 'Project proj_1' }, personas: [], documents: DOCUMENTS, access: OWNER_ACCESS },
};

const LOCKED: AiWritingPolicy = { mode: 'human_driven', interactive: new Set(), autonomous: false };
const PRFAQ_UNLOCKED: AiWritingPolicy = { mode: 'human_driven', interactive: new Set(['prfaq']), autonomous: false };
const AI_DRIVEN: AiWritingPolicy = { mode: 'ai_driven', interactive: new Set(['prfaq', 'prd']), autonomous: true };

function catalogueHarness(turns: ScriptedTurn[], loadAiWriting: LoadAiWritingPolicy): Harness {
  const catalogue = buildCatalogue(fakeDeps(ROUTES));
  const h = harness(turns);
  h.deps.getToolset = (options) => selectToolset(catalogue, options);
  h.deps.loadAiWriting = loadAiWriting;
  return h;
}

const projectPage = () => runBody({
  forwardedProps: { page: { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' } },
  messages: [{ id: 'u1', role: 'user', content: 'Write the PRD for me' }],
});


/** Runs one attempted write (then a closing text turn) under `policy`. */
async function attempt(name: string, input: Record<string, unknown>, policy: AiWritingPolicy): Promise<{ h: Harness; events: BaseEvent[] }> {
  const h = catalogueHarness([{ toolUses: [{ id: 'tu_w', name, input }] }, { text: 'Let me coach you instead.' }], () => Promise.resolve(policy));
  return { h, events: await run(projectPage(), h) };
}

function refusalText(h: Harness): unknown {
  return nth(lastUserContent(nth(h.calls, 1)), 0).toolResult?.content?.at(0);
}

describe('runAssistant — Human-driven, nothing unlocked', () => {
  it('never offers generate_document and adds the coaching section to the prompt', async () => {
    const h = catalogueHarness([{ text: 'Tell me what you would say first.' }], () => Promise.resolve(LOCKED));
    await run(projectPage(), h);
    const offered = offeredTools(h);
    expect([offered.includes('generate_document'), offered.includes('update_document'), offered.includes('merge_documents')])
      .toStrictEqual([false, true, true]);
    expect(nth(h.calls, 0).systemSuffix).toContain('## Way of working with AI');
    expect(nth(h.calls, 0).systemSuffix).toContain('Never draft, rewrite, complete or produce paste-ready');
  });

  it('refuses an update of a stored PRD before any card', async () => {
    const { h, events } = await attempt('update_document', { document_id: 'd_prd', content: '# PRD', change_summary: 'Rewrote' }, LOCKED);
    expect(h.calls).toHaveLength(2);
    expect(refusalText(h)).toMatchObject({ text: expect.stringContaining('Human-driven on PRDs') });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('refuses a merge into a PR/FAQ before any card', async () => {
    const { h, events } = await attempt('merge_documents', {
      output_type: 'prfaq', title: 'Merged', instructions: 'Merge them', document_ids: ['d_prd', 'd_custom'],
    }, LOCKED);
    expect(refusalText(h)).toMatchObject({ text: expect.stringContaining('Human-driven on PR/FAQs') });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('still lets an update of a custom document through to approval', async () => {
    const { events } = await attempt('update_document', { document_id: 'd_custom', content: '# Notes', change_summary: 'Tidied' }, LOCKED);
    expect(finished(events).outcome).toMatchObject({ type: 'interrupt', interrupts: [{ toolCallId: 'tu_w', metadata: { toolName: 'update_document' } }] });
  });
});

describe('runAssistant — unlocks, AI-driven and an unreadable mode', () => {
  it('offers generate_document again once PR/FAQ is unlocked, and lets a PR/FAQ generation reach its card', async () => {
    const { h, events } = await attempt('generate_document', { doc_type: 'prfaq', title: 'Launch', feature_idea: 'Offline mode' }, PRFAQ_UNLOCKED);
    expect(offeredTools(h)).toContain('generate_document');
    expect(finished(events).outcome).toMatchObject({ type: 'interrupt', interrupts: [{ metadata: { toolName: 'generate_document' } }] });
  });

  it('refuses a PRD generation when only PR/FAQ is unlocked', async () => {
    const { h } = await attempt('generate_document', { doc_type: 'prd', title: 'Spec', feature_idea: 'Offline mode' }, PRFAQ_UNLOCKED);
    expect(refusalText(h)).toMatchObject({ text: expect.stringContaining('Human-driven on PRDs') });
  });

  it('adds no section and lets a PRD update through for AI-driven', async () => {
    const { h, events } = await attempt('update_document', { document_id: 'd_prd', content: '# PRD', change_summary: 'Rewrote' }, AI_DRIVEN);
    expect(nth(h.calls, 0).systemSuffix).not.toContain('Way of working with AI');
    expect(finished(events).outcome).toMatchObject({ type: 'interrupt' });
  });

  it('reads an unreadable mode as locked: no generate_document, the coaching section present', async () => {
    const h = catalogueHarness([{ text: 'Coaching.' }], () => Promise.reject(new Error('AccessDenied')));
    await run(projectPage(), h);
    expect(offeredTools(h)).not.toContain('generate_document');
    expect(nth(h.calls, 0).systemSuffix).toContain('## Way of working with AI');
  });
});
