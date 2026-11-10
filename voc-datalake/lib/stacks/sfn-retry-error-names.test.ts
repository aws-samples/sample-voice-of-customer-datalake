/**
 * Step Functions retries match a Lambda error by NAME: the `errorType` Lambda reports is the raised
 * class's `__name__`. A Python alias (`OldName = NewName`) does not change `__name__`, so a retry on
 * the alias never fires. That is how the research and document workflows once retried on
 * `BedrockThrottlingException` while the Lambda raised `BedrockThrottlingError`: a throttled step
 * failed at once. This pins the two LLM workflows' custom error names to real classes;
 * scripts/audit/py_sfn_errors.py is the general guard over every state machine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate } from '../test-support/api-stack-template';
import { stateMachineDefinition, synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const BUILT_IN_PREFIXES = ['States.', 'Lambda.', 'Sandbox.'];
const CONVERSE_SOURCE = join(__dirname, '..', '..', 'lambda', 'shared', 'converse.py');

/** Every name in every `ErrorEquals` of a compact-JSON definition (retries and catches alike). */
function errorNames(definition: string): string[] {
  const lists = [...definition.matchAll(/"ErrorEquals":\[([^\]]*)\]/g)];
  return lists.flatMap((match) => [...(match[1] ?? '').matchAll(/"([^"]+)"/g)].map((name) => name[1] ?? ''));
}

function customNames(definition: string): string[] {
  return [...new Set(errorNames(definition))]
    .filter((name) => !BUILT_IN_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort(byCodeUnit);
}

/** Classes defined in shared/converse.py: `class Name(` at the start of a line (an alias never matches). */
function converseClasses(): Set<string> {
  const source = readFileSync(CONVERSE_SOURCE, 'utf-8');
  return new Set([...source.matchAll(/^class (\w+)\(/gm)].map((match) => match[1] ?? ''));
}

describe('Step Functions retry error names are real Lambda error types', () => {
  const state = { research: '', document: '' };
  beforeAll(() => {
    state.research = stateMachineDefinition(synthProcessingTemplate(), 'ResearchStateMachine');
    state.document = stateMachineDefinition(apiTemplate(), 'DocumentStateMachine');
  }, SYNTH_TIMEOUT_MS);

  it.each(['research', 'document'] as const)('the %s workflow retries Bedrock throttling by its class name', (which) => {
    expect(customNames(state[which])).toStrictEqual(['BedrockThrottlingError']);
  });

  it('every custom name is a class defined in shared/converse.py', () => {
    const classes = converseClasses();
    const names = customNames(state.research + state.document);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !classes.has(name))).toStrictEqual([]);
  });
});
