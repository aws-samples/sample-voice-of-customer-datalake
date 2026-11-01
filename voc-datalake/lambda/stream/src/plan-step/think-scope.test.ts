import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { buildCatalogue } from '../assistant/tools/catalogue.js';
import { fakeContext, fakeDeps } from '../assistant/tools/test-fixtures.js';
import { runThinkStep } from './think.js';

describe('think steps and category names (owner rule 2026-10-21)', () => {
  it('tell the model to name and count only the categories its tools return', async () => {
    const commands: ConverseCommand[] = [];
    await runThinkStep({
      invoke: () => Promise.reject(new Error('no reads in this test')),
      catalogue: buildCatalogue(fakeDeps()),
      converse: (command) => {
        commands.push(command);
        return Promise.resolve({ output: { message: { role: 'assistant', content: [{ text: 'Done.' }] } }, stopReason: 'end_turn', $metadata: {}, metrics: undefined, usage: undefined });
      },
      resolveModel: () => Promise.resolve('global.anthropic.claude-sonnet-5-5'),
      lookupStoreApp: () => Promise.resolve({ status: 'found', app: { name: '', developer: '', url: '' } }),
    }, {
      step: { id: 's1', pack: 'core', kind: 'think', title: 'Summarise', think: { brief: 'Summarise the complaints.' } },
      ctx: fakeContext(), context: '', modelId: 'global.anthropic.claude-sonnet-5-5',
    });
    const system = commands[0]?.input.system?.map((block) => block.text ?? '').join('') ?? '';
    expect(system).toContain('Name and count only the categories your tools return');
  });
});
