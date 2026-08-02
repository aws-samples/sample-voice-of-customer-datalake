/**
 * Template-level tests for the research Step Functions wiring.
 *
 * Regression guard for issue #157: step_initialize's outputs only reach
 * later steps if InitializeResearch's resultSelector selects them AND the
 * consuming step's payload forwards them. documents_context was silently
 * dropped by the selector, so selected reference documents never reached
 * the analysis prompt. These tests fail if either half of the wiring is
 * removed again (e.g. in a conflict resolution on the selector block).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { VocProcessingStack } from './processing-stack-consolidated';

function synthProcessingTemplate(): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  const makeTable = (id: string, props: Partial<dynamodb.TableProps> = {}) =>
    new dynamodb.Table(deps, id, {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      ...props,
    });

  const stack = new VocProcessingStack(app, 'TestProcessing', {
    env,
    feedbackTable: makeTable('Feedback', { stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES }),
    aggregatesTable: makeTable('Aggregates'),
    projectsTable: makeTable('Projects'),
    jobsTable: makeTable('Jobs'),
    idempotencyTable: makeTable('Idempotency'),
    processingQueue: new sqs.Queue(deps, 'Queue'),
    kmsKey: new kms.Key(deps, 'Key'),
    config: {
      brandName: 'TestBrand',
      brandHandles: ['@testbrand'],
      primaryLanguage: 'en',
      enabledSources: [],
    },
  });

  return Template.fromStack(stack);
}

/** The state machine definition as raw JSON text. DefinitionString is an
 * Fn::Join of string fragments and Lambda ARN refs; joining just the string
 * fragments yields searchable JSON (with real quotes, so assertions can pin
 * exact `"key.$":"path"` pairs). */
function researchDefinition(template: Template): string {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const ids = Object.keys(machines);
  expect(ids).toHaveLength(1);
  const definition: unknown = machines[ids[0]].Properties.DefinitionString;
  if (
    typeof definition === 'object' && definition !== null &&
    'Fn::Join' in definition && Array.isArray(definition['Fn::Join'])
  ) {
    const [, pieces] = definition['Fn::Join'] as [unknown, unknown];
    if (Array.isArray(pieces)) {
      return pieces.filter((piece): piece is string => typeof piece === 'string').join('');
    }
  }
  // A definition without refs synthesizes as a plain string.
  expect(typeof definition).toBe('string');
  return String(definition);
}

describe('research state machine wiring (issue #157)', () => {
  // Synthesized in beforeAll so a synth failure reports as a test failure
  // with a name, not a file-collection error.
  //
  // NOTE: the exact '"key.$":"path"' pins assume CDK's compact JSON
  // serialization of the definition (no whitespace around ':'). Stable
  // today; if a CDK upgrade ever pretty-prints definitions, all three
  // tests fail together — loosen to a whitespace-tolerant match then.
  const state: { definition: string } = { definition: '' };
  beforeAll(() => {
    state.definition = researchDefinition(synthProcessingTemplate());
  });

  it('selects documents_context out of the initialize result', () => {
    expect(state.definition).toContain('"documents_context.$":"$.Payload.documents_context"');
  });

  it('forwards documents_context into the analyze step payload', () => {
    expect(state.definition).toContain('"documents_context.$":"$.initialize_result.documents_context"');
  });

  it('keeps the sibling context selections intact', () => {
    // The same silent-drop failure mode applies to every initialize output
    // the analyze prompt consumes; pin the full set that must flow.
    for (const key of ['feedback_context', 'feedback_stats', 'personas_context', 'web_context']) {
      expect(state.definition).toContain(`"${key}.$":"$.Payload.${key}"`);
      expect(state.definition).toContain(`"${key}.$":"$.initialize_result.${key}"`);
    }
  });

  it('flows the executed web-search queries to the save step (#207)', () => {
    // step_initialize ALWAYS returns web_search_queries ([] when web search
    // is off); step_save consumes it for the report's disclosure section.
    expect(state.definition).toContain('"web_search_queries.$":"$.Payload.web_search_queries"');
    expect(state.definition).toContain('"web_search_queries.$":"$.initialize_result.web_search_queries"');
  });
});

/**
 * research_step_handler resolves its system prompts and token budgets from
 * api/prompts/research-analysis.json at RUNTIME, so that file must be copied into
 * the bundle AND be part of the asset fingerprint. The first deploy of that change
 * shipped a bundle with no prompts/ at all — a FileNotFoundError on every research
 * job that the whole unit suite missed, because get_prompts_dir() resolves the repo
 * layout locally whether or not the bundle stages anything.
 *
 * These are source assertions, which is a weak form: they cannot prove staging, and
 * they break on reformatting. Kept only because bundling inputs appear in neither
 * the synthesized template nor the assets manifest, so the alternative is a
 * finch-dependent synth in unit tests. The behavioural half of this guard lives in
 * lambda/research/test/test_research_step_budgets.py, which fails if a step stops
 * reading the config at all.
 */
/**
 * Raised in review of PR #228: moving the research budgets to config (9000 +
 * a 5000 thinking budget, up from 4000/0) increases per-step generation time, and
 * a mid-generation timeout throws the step away — the same failure the ingestor
 * sizing change fixes.
 *
 * The function already runs at Lambda's 15-minute HARD MAXIMUM, so there is no
 * headroom left to add: the only thing worth guarding is that nobody lowers it
 * while budgets are config-driven and can be raised by editing a JSON file.
 */
describe('research Lambda keeps the maximum timeout its budgets assume', () => {
  const MAX_LAMBDA_TIMEOUT_SECONDS = 900;
  let researchFn: Record<string, unknown>;

  beforeAll(() => {
    const fns = synthProcessingTemplate().findResources('AWS::Lambda::Function');
    const entry = Object.entries(fns).find(
      ([id]) => id.startsWith('ResearchStepLambda'),
    );
    expect(entry, 'ResearchStepLambda not found in the template').toBeDefined();
    researchFn = (entry![1] as { Properties: Record<string, unknown> }).Properties;
  });

  it('runs at the maximum Lambda timeout', () => {
    expect(researchFn.Timeout).toBe(MAX_LAMBDA_TIMEOUT_SECONDS);
  });

  it('has enough memory that generation is not CPU-starved', () => {
    // Lambda scales CPU with memory; a small function makes long generations
    // slower and therefore likelier to hit the ceiling above.
    expect(researchFn.MemorySize as number).toBeGreaterThanOrEqual(1024);
  });
});

describe('research Lambda bundle stages its prompt config', () => {
  const source = readFileSync(join(__dirname, 'processing-stack-consolidated.ts'), 'utf-8');
  const researchAsset = source.split('const researchCode')[1]?.split('});')[0] ?? '';

  it('copies the prompts to the bundle root where get_prompts_dir looks first', () => {
    // THIS is the assertion that maps to the actual bug: a bundled asset mounts
    // the source dir as /asset-input, so the copy — not the exclude — is what puts
    // the config in the bundle. Verified empirically by reverting each half.
    expect(researchAsset).toContain('/asset-input/api/prompts /asset-output/prompts');
  });

  it('keeps api/prompts inside the asset fingerprint', () => {
    // Excluding api/ wholesale still bundles the prompts (the copy handles that),
    // but drops them from the hash — so editing research-analysis.json would not
    // redeploy the function and it would keep running the old budgets.
    expect(researchAsset).toContain("'!/api/prompts'");
    expect(researchAsset).not.toContain("'/api/',");
  });

  it('still excludes the sibling handler trees it does not ship', () => {
    // Re-including prompts must not become "stage everything", which would
    // redeploy this function on unrelated edits.
    for (const excluded of ["'/aggregator/'", "'/jobs/'", "'/processor/'"]) {
      expect(researchAsset).toContain(excluded);
    }
  });
});
