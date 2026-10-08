import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { EventType } from '@ag-ui/core';
import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../../lib/errors.js';
import { nth } from '../../../lib/nth-fixtures.js';
import { buildCatalogue } from '../catalogue.js';
import type { ToolDeps } from '../deps.js';
import { fakeContext, fakeDeps } from '../test-fixtures.js';
import { normalizeLanguage } from './consult-personas.js';

const CONTEXT_ROUTE = 'POST /projects/proj_1/chat-context';

const CHAT_CONTEXT = {
  project: { sk: 'META', name: 'Checkout' },
  personas: [
    { sk: 'PERSONA#p1', persona_id: 'p1', name: 'Pat', tagline: 'Busy parent', avatar_url: 's3://b/avatars/p1.png',
      goals_motivations: { primary_goal: 'Save time' }, pain_points: null },
    { sk: 'PERSONA#p2', persona_id: 'p2', name: 'Sam', quotes: [{ text: 'Price matters' }] },
  ],
  documents: [],
};

function answer(text: string): ConverseCommandOutput {
  return {
    output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'hmm' } } }, { text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
    $metadata: {},
  };
}

function setup(converse: ToolDeps['converse']) {
  const commands: ConverseCommand[] = [];
  const deps = fakeDeps({ [CONTEXT_ROUTE]: CHAT_CONTEXT }, {
    converse: (command) => {
      commands.push(command);
      return converse(command);
    },
    resolveAvatar: (url) => Promise.resolve(url ? 'https://cdn.example/avatars/p1.png?Signature=s' : undefined),
  });
  const tool = buildCatalogue(deps).find((candidate) => candidate.name === 'consult_personas');
  if (tool?.kind !== 'server') throw new TypeError('consult_personas missing');
  return { tool, commands };
}

function systemText(command: ConverseCommand | undefined): string {
  return command?.input.system?.map((block) => ('text' in block ? block.text : '')).join('') ?? '';
}

describe('consult_personas', () => {
  it('asks each persona once with its own prompt and returns persona cards JSON', async () => {
    const { tool, commands } = setup((command) => Promise.resolve(answer(
      systemText(command).includes('"Pat"') ? 'I want speed.' : 'I want low prices.',
    )));
    const ctx = fakeContext('project', { projectId: 'proj_1' });

    const result = await tool.execute({ question: 'One-click checkout?' }, ctx);

    expect(JSON.parse(result.content)).toStrictEqual({
      responses: [
        { persona_id: 'p1', name: 'Pat', avatar_url: 'https://cdn.example/avatars/p1.png?Signature=s', answer: 'I want speed.' },
        { persona_id: 'p2', name: 'Sam', answer: 'I want low prices.' },
      ],
    });
    expect(commands).toHaveLength(2);
    expect(systemText(commands[0])).toContain('Save time');
    expect(commands[0]?.input.messages).toStrictEqual([{ role: 'user', content: [{ text: 'One-click checkout?' }] }]);
  });

  it('uses the run model, sends no tools and no temperature, and omits thinking for adaptive models', async () => {
    const { tool, commands } = setup(() => Promise.resolve(answer('ok')));
    await tool.execute({ question: 'q', persona_ids: ['p1'] }, fakeContext('project', { projectId: 'proj_1' }));
    const { input } = nth(commands, 0);
    expect({
      modelId: input.modelId,
      toolConfig: input.toolConfig,
      inferenceConfig: input.inferenceConfig,
      additionalModelRequestFields: input.additionalModelRequestFields,
    }).toStrictEqual({
      modelId: 'global.anthropic.claude-sonnet-5',
      toolConfig: undefined,
      inferenceConfig: { maxTokens: 1200 },
      additionalModelRequestFields: undefined,
    });
  });

  it('gives non-adaptive models a bounded explicit thinking budget', async () => {
    const { tool, commands } = setup(() => Promise.resolve(answer('ok')));
    const ctx = fakeContext('project', { projectId: 'proj_1' }, { modelId: 'global.anthropic.claude-sonnet-4-6' });
    await tool.execute({ question: 'q', persona_ids: ['p2'] }, ctx);
    expect(commands[0]?.input.additionalModelRequestFields).toStrictEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
  });

  it('sends the eu. profile of the run model on an EU deployment', async () => {
    vi.stubEnv('BEDROCK_INFERENCE_SCOPE', 'eu');
    try {
      const { tool, commands } = setup(() => Promise.resolve(answer('ok')));
      await tool.execute({ question: 'q', persona_ids: ['p1'] }, fakeContext('project', { projectId: 'proj_1' }));
      expect(nth(commands, 0).input.modelId).toBe('eu.anthropic.claude-sonnet-5');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('emits STEP_STARTED / STEP_FINISHED per persona', async () => {
    const { tool } = setup(() => Promise.resolve(answer('ok')));
    const ctx = fakeContext('project', { projectId: 'proj_1' });
    await tool.execute({ question: 'q' }, ctx);
    expect(ctx.events).toStrictEqual([
      { type: EventType.STEP_STARTED, stepName: 'persona:Pat' },
      { type: EventType.STEP_STARTED, stepName: 'persona:Sam' },
      { type: EventType.STEP_FINISHED, stepName: 'persona:Pat' },
      { type: EventType.STEP_FINISHED, stepName: 'persona:Sam' },
    ]);
  });

  it('keeps going when one persona call fails', async () => {
    const { tool } = setup((command) => (systemText(command).includes('"Pat"')
      ? Promise.reject(new ServiceError('throttled'))
      : Promise.resolve(answer('fine'))));
    const result = await tool.execute({ question: 'q' }, fakeContext('project', { projectId: 'proj_1' }));
    const parsed: unknown = JSON.parse(result.content);
    expect(parsed).toMatchObject({ responses: [{ persona_id: 'p1', answer: expect.stringContaining('could not be consulted') }, { answer: 'fine' }] });
  });

  it('rejects unknown persona ids and needs a project', async () => {
    const { tool } = setup(() => Promise.resolve(answer('ok')));
    await expect(tool.execute({ question: 'q', persona_ids: ['nope'] }, fakeContext('project', { projectId: 'proj_1' })))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(tool.execute({ question: 'q' }, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('adds the language instruction for the UI language', async () => {
    const { tool, commands } = setup(() => Promise.resolve(answer('ok')));
    const page = { kind: 'project' as const, path: '/projects/proj_1', projectId: 'proj_1' };
    await tool.execute({ question: 'q', persona_ids: ['p1'] }, fakeContext('project', page, { props: { page, responseLanguage: 'de-DE' } }));
    expect(systemText(commands[0])).toContain('German');
  });
});

describe('normalizeLanguage', () => {
  it.each([['pt-BR', 'pt'], ['KO', 'ko'], ['xx', undefined], [undefined, undefined]])('%s → %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
});
