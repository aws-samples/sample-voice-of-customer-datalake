/**
 * The project job state machines carry the run's workspace to every state's Lambda (docs/multi-workspace.md, the
 * project plan, 3c; since 7.29.00; lib/utils/run-scope.ts). A run's first state is a Choice on the input's optional
 * `workspace_id` that sets `$.run_scope` (`{workspace_id}`, or `{}` for a run of the deployment, whose input is
 * unchanged), and every Lambda payload keeps its existing paths and adds `run_scope`. The definitions are pinned
 * state by state; voc-agent-run's ASL file is pinned by lambda/agents/test/test_state_machine_run_scope.py and
 * memory-agents-stack.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate } from '../test-support/api-stack-template';
import { isRecord, recordAt } from '../test-support/guards';
import { stateMachineDefinition, synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const RUN_SCOPE = { 'run_scope.$': '$.run_scope' };
const IDS = { 'job_id.$': '$.job_id', 'project_id.$': '$.project_id', ...RUN_SCOPE };

/** The definition as an object (each token, a Lambda ARN or the partition, dropped from inside its string). */
function definitionOf(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('a state machine definition is an object');
  return parsed;
}

function states(definition: Record<string, unknown>): Record<string, unknown> {
  const found = recordAt(definition, 'States');
  if (found === undefined) throw new Error('a definition has States');
  return found;
}

function payloads(definition: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(states(definition))
    .filter(([, state]) => isRecord(state) && state.Type === 'Task')
    .map(([name, state]) => [name, recordAt(state, 'Parameters', 'Payload')]));
}

/**
 * A machine's three run-scope states, their names' prefix stripped and their first state's name replaced by
 * `<first>`: so the CDK helper's (lib/utils/run-scope.ts) and voc-agent-run's own (lambda/agents/state_machine.py)
 * compare as one definition.
 */
function runScopeStates(definition: Record<string, unknown>, prefix: string, first: string): unknown {
  const all = states(definition);
  const own = Object.fromEntries(['RunScope', 'RunScopeWorkspace', 'RunScopeDeployment']
    .map((name) => [name, all[`${prefix}${name}`]]));
  const text = JSON.stringify(own)
    .split(`"${prefix}RunScope`).join('"RunScope')
    .split(`"Next":"${first}"`).join('"Next":"<first>"');
  return JSON.parse(text);
}

/** voc-agent-run's committed definition (rendered by lambda/agents/state_machine.py). */
function agentRunDefinition(): Record<string, unknown> {
  return definitionOf(readFileSync(join(__dirname, '../../lambda/agents/state_machine.asl.json'), 'utf8'));
}

function expectRunScopeStart(definition: Record<string, unknown>, prefix: string, first: string): void {
  expect(definition.StartAt).toBe(`${prefix}RunScope`);
  const all = states(definition);
  expect(all[`${prefix}RunScope`]).toStrictEqual({
    Type: 'Choice',
    Choices: [{ Variable: '$.workspace_id', IsPresent: true, Next: `${prefix}RunScopeWorkspace` }],
    Default: `${prefix}RunScopeDeployment`,
  });
  expect(all[`${prefix}RunScopeWorkspace`]).toStrictEqual({
    Type: 'Pass', Parameters: { 'workspace_id.$': '$.workspace_id' }, ResultPath: '$.run_scope', Next: first,
  });
  expect(all[`${prefix}RunScopeDeployment`]).toStrictEqual({
    Type: 'Pass', Result: {}, ResultPath: '$.run_scope', Next: first,
  });
}

describe('voc-document-workflow passes the run scope to every state', () => {
  const state: { definition: Record<string, unknown> } = { definition: {} };
  beforeAll(() => {
    state.definition = definitionOf(stateMachineDefinition(apiTemplate(), 'DocumentStateMachine'));
  }, SYNTH_TIMEOUT_MS);

  it('starts by setting $.run_scope from the optional workspace_id, then gathers', () => {
    expectRunScopeStart(state.definition, 'Doc', 'DocGather');
  });

  it('builds the same three first states as voc-agent-run\'s Python definition', () => {
    expect(runScopeStates(state.definition, 'Doc', 'DocGather'))
      .toStrictEqual(runScopeStates(agentRunDefinition(), '', 'Start'));
  });

  it('keeps every Lambda payload\'s paths and adds run_scope', () => {
    const step = (index: number) => ({ step: 'run_step', index, ...IDS });
    expect(payloads(state.definition)).toStrictEqual({
      DocGather: { step: 'gather', ...IDS, 'doc_config.$': '$.doc_config' },
      DocStep0: step(0), DocStep1: step(1), DocStep2: step(2), DocStep3: step(3),
      DocSave: {
        step: 'save', ...IDS, 'doc_type.$': '$.gathered.doc_type', 'title.$': '$.gathered.title',
        'feature_idea.$': '$.gathered.feature_idea', 'num_steps.$': '$.gathered.num_steps',
      },
      DocHandleError: { step: 'error', ...IDS, 'error.$': '$.error' },
    });
  });
});

describe('voc-research-workflow passes the run scope to every state', () => {
  const state: { definition: Record<string, unknown> } = { definition: {} };
  beforeAll(() => {
    state.definition = definitionOf(stateMachineDefinition(synthProcessingTemplate(), 'ResearchStateMachine'));
  }, SYNTH_TIMEOUT_MS);

  it('starts by setting $.run_scope from the optional workspace_id, then initializes', () => {
    expectRunScopeStart(state.definition, 'Research', 'InitializeResearch');
  });

  it('builds the same three first states as voc-agent-run\'s Python definition', () => {
    expect(runScopeStates(state.definition, 'Research', 'InitializeResearch'))
      .toStrictEqual(runScopeStates(agentRunDefinition(), '', 'Start'));
  });

  it('keeps every Lambda payload\'s paths and adds run_scope', () => {
    const config = { 'research_config.$': '$.research_config' };
    expect(payloads(state.definition)).toStrictEqual({
      InitializeResearch: { step: 'initialize', ...IDS, ...config },
      AnalyzeFeedback: {
        step: 'analyze', ...IDS, ...config,
        'grounding_included.$': '$.initialize_result.grounding_included',
        'feedback_stats.$': '$.initialize_result.feedback_stats',
        'personas_context.$': '$.initialize_result.personas_context',
        'web_context.$': '$.initialize_result.web_context',
        'documents_context.$': '$.initialize_result.documents_context',
      },
      SynthesizeFindings: {
        step: 'synthesize', ...IDS, ...config,
        'grounding_included.$': '$.initialize_result.grounding_included',
        'analysis.$': '$.analysis_result.analysis',
      },
      ValidateResearch: {
        step: 'validate', ...IDS, ...config,
        'analysis.$': '$.analysis_result.analysis', 'synthesis.$': '$.synthesis_result.synthesis',
      },
      SaveResearchResults: {
        step: 'save', ...IDS, ...config,
        'feedback_count.$': '$.initialize_result.feedback_count',
        'web_search_queries.$': '$.initialize_result.web_search_queries',
        'derivation.$': '$.initialize_result.derivation',
        'feedback_usage.$': '$.initialize_result.feedback_usage',
        'analysis.$': '$.analysis_result.analysis',
        'synthesis.$': '$.synthesis_result.synthesis',
        'validation.$': '$.validate_result.validation',
      },
      HandleResearchError: { step: 'error', ...IDS, 'error.$': '$.error' },
    });
  });
});
