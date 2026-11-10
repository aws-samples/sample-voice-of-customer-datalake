/**
 * The caller's way of working with AI (ai-writing.ts) and the pre-card guard built on it
 * (tools/ai-writing-guard.ts), docs/ways-of-working.md:
 * - the stored row → policy matrix (3 modes × the two unlocks), mirroring lambda/shared/ai_mode.py
 *   (no row and an unknown mode read AI-driven);
 * - fail CLOSED: a failed, slow or unconfigured read is Human-driven with nothing unlocked;
 * - which interactive writes (generate / merge) and which plan steps (autonomous) are refused;
 * - the system-prompt section per mode.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { aiWritingRefusal } from '../tools/ai-writing-guard.js';
import {
  aiWritingForRun, aiWritingPromptLines, createAiWritingLoader, mayWriteInteractively, type AiWritingPolicy,
} from './ai-writing.js';
import { silenceConsole } from './__fixtures__/harness.js';

silenceConsole();

interface DocClientLike {
  send: ReturnType<typeof vi.fn>;
}

function isDocClient(client: DocClientLike): client is DocClientLike & DynamoDBDocumentClient {
  return typeof client.send === 'function';
}

function docClient(send: DocClientLike['send']): DynamoDBDocumentClient & DocClientLike {
  const double: DocClientLike = { send };
  if (!isDocClient(double)) throw new Error('test double is not send-able');
  return double;
}

/** The policy a stored row (or no row) loads as. */
async function policyOf(item: Record<string, unknown> | undefined): Promise<AiWritingPolicy> {
  return createAiWritingLoader(docClient(vi.fn().mockResolvedValue({ Item: item })), 'voc-aggregates')('sub-1');
}

/** A policy as plain data, for whole-value comparisons (interactive types in a fixed order). */
function shape(policy: AiWritingPolicy): { mode: string; interactive: string[]; autonomous: boolean } {
  const interactive = ['prd', 'prfaq'].filter((type) => mayWriteInteractively(policy, type));
  return { mode: policy.mode, interactive, autonomous: policy.autonomous };
}

const AI_DRIVEN = { mode: 'ai_driven', interactive: ['prd', 'prfaq'], autonomous: true };
const LOCKED = { mode: 'human_driven', interactive: [], autonomous: false };

describe('createAiWritingLoader', () => {
  it('reads the caller’s own USERFLAGS row, strongly consistent', async () => {
    const send = vi.fn().mockResolvedValue({});
    await createAiWritingLoader(docClient(send), 'voc-aggregates')('sub-1');
    expect(send.mock.calls[0]?.[0].input).toStrictEqual({
      TableName: 'voc-aggregates', Key: { pk: 'USERFLAGS#sub-1', sk: 'ai_mode' }, ConsistentRead: true,
    });
  });

  it.each([
    ['no row', undefined, AI_DRIVEN],
    ['ai_driven', { mode: 'ai_driven' }, AI_DRIVEN],
    ['an unknown mode (as ai_mode.py)', { mode: 'robot' }, AI_DRIVEN],
    ['ai_assisted', { mode: 'ai_assisted' }, { mode: 'ai_assisted', interactive: ['prd', 'prfaq'], autonomous: false }],
    ['ai_assisted with unlocks (they add nothing)', { mode: 'ai_assisted', ai_writing_prfaq: true }, { mode: 'ai_assisted', interactive: ['prd', 'prfaq'], autonomous: false }],
    ['human_driven', { mode: 'human_driven' }, LOCKED],
    ['human_driven + PR/FAQ unlocked', { mode: 'human_driven', ai_writing_prfaq: true }, { mode: 'human_driven', interactive: ['prfaq'], autonomous: false }],
    ['human_driven + PRD unlocked', { mode: 'human_driven', ai_writing_prd: true }, { mode: 'human_driven', interactive: ['prd'], autonomous: false }],
    ['human_driven + both unlocked', { mode: 'human_driven', ai_writing_prfaq: true, ai_writing_prd: true }, { mode: 'human_driven', interactive: ['prd', 'prfaq'], autonomous: false }],
    ['human_driven + an unlock that is not literally true', { mode: 'human_driven', ai_writing_prfaq: 'true', ai_writing_prd: 1 }, LOCKED],
  ])('%s → its policy', async (_label, item, expected) => {
    expect(shape(await policyOf(item))).toStrictEqual(expected);
  });
});

describe('aiWritingForRun (fails closed)', () => {
  it('is AI-driven without a loader, the loaded policy otherwise', async () => {
    const human = await policyOf({ mode: 'human_driven', ai_writing_prd: true });
    const answers = await Promise.all([aiWritingForRun(undefined, 'sub-1'), aiWritingForRun(() => Promise.resolve(human), 'sub-1')]);
    expect(answers.map(shape)).toStrictEqual([AI_DRIVEN, shape(human)]);
  });

  it('is Human-driven with nothing unlocked on a throw, a timeout or a missing table name', async () => {
    const unconfigured = createAiWritingLoader(docClient(vi.fn().mockResolvedValue({})), '');
    const answers = await Promise.all([
      aiWritingForRun(() => Promise.reject(new Error('AccessDenied')), 'sub-1'),
      aiWritingForRun(() => new Promise<AiWritingPolicy>(() => {}), 'sub-1', 5),
      aiWritingForRun(unconfigured, 'sub-1'),
    ]);
    expect(answers.map(shape)).toStrictEqual([LOCKED, LOCKED, LOCKED]);
  });
});

describe('mayWriteInteractively', () => {
  it('gates only PR/FAQs and PRDs', async () => {
    const prdOnly = await policyOf({ mode: 'human_driven', ai_writing_prd: true });
    expect(['prd', 'prfaq', 'custom', 'research', undefined].map((type) => mayWriteInteractively(prdOnly, type)))
      .toStrictEqual([true, false, true, true, true]);
    expect(mayWriteInteractively(undefined, 'prfaq')).toBe(true);
  });
});

describe('aiWritingRefusal (before any card)', () => {
  const generate = (docType: string) => ({ project_id: 'p1', doc_type: docType, title: 'T', feature_idea: 'Idea' });
  const merge = (outputType: string) => ({ project_id: 'p1', output_type: outputType, title: 'T', instructions: 'Merge', document_ids: ['a', 'b'] });
  const plan = (tool: string, args: Record<string, unknown>) => ({ steps: [{ id: 's1', write: { tool, args } }] });

  it('refuses a generate / merge into a locked type and names it, lets the rest through', async () => {
    const prfaqOnly = await policyOf({ mode: 'human_driven', ai_writing_prfaq: true });
    const refusals = [
      aiWritingRefusal('generate_document', generate('prd'), prfaqOnly),
      aiWritingRefusal('merge_documents', merge('prd'), prfaqOnly),
      aiWritingRefusal('generate_document', generate('prfaq'), prfaqOnly),
      aiWritingRefusal('merge_documents', merge('custom'), prfaqOnly),
      aiWritingRefusal('create_project', { name: 'x' }, prfaqOnly),
    ];
    expect(refusals.map((r) => r === undefined)).toStrictEqual([false, false, true, true, true]);
    expect(refusals[0]).toContain('Human-driven on PRDs');
  });

  it('refuses a plan that would write a PR/FAQ or PRD autonomously unless the person is AI-driven', async () => {
    const [assisted, driven] = await Promise.all([policyOf({ mode: 'ai_assisted' }), policyOf(undefined)]);
    const plans = [
      plan('generate_document', generate('prfaq')),
      plan('merge_documents', merge('prd')),
      plan('merge_documents', merge('custom')),
      plan('create_project', { name: 'x' }),
    ];
    expect(plans.map((p) => aiWritingRefusal('propose_plan', p, assisted) === undefined)).toStrictEqual([false, false, true, true]);
    expect(plans.map((p) => aiWritingRefusal('propose_plan', p, driven))).toStrictEqual([undefined, undefined, undefined, undefined]);
    expect(aiWritingRefusal('propose_plan', plans[0] ?? {}, assisted)).toContain('agents and approved plans may not write');
  });

  it('refuses nothing without a policy (plan steps, tests)', () => {
    expect(aiWritingRefusal('generate_document', generate('prd'), undefined)).toBeUndefined();
  });
});

describe('aiWritingPromptLines', () => {
  it('adds nothing for AI-driven (or no policy), only the plan rule for AI-assisted', async () => {
    const [driven, assisted] = await Promise.all([policyOf(undefined), policyOf({ mode: 'ai_assisted' })]);
    const assistedText = aiWritingPromptLines(assisted).join('\n');
    expect([aiWritingPromptLines(driven), aiWritingPromptLines(undefined)]).toStrictEqual([[], []]);
    expect([assistedText.includes('never propose a plan step'), assistedText.includes('Never draft')]).toStrictEqual([true, false]);
  });

  it('adds the coaching rule naming exactly the locked types', async () => {
    const [human, prdOnly] = await Promise.all([
      policyOf({ mode: 'human_driven' }), policyOf({ mode: 'human_driven', ai_writing_prd: true }),
    ]);
    const humanText = aiWritingPromptLines(human).join('\n');
    expect([
      humanText.includes('Human-driven on PR/FAQ and PRD'),
      humanText.includes('Never draft, rewrite, complete or produce paste-ready'),
      aiWritingPromptLines(prdOnly).join('\n').includes('Human-driven on PR/FAQ: they write it'),
    ]).toStrictEqual([true, true, true]);
  });
});
