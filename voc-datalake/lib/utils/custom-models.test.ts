/**
 * The `-c customModels` registry (lib/utils/custom-models.ts, 7.65.00): what the synth accepts and refuses (the id's
 * shape by kind, the residency rules under both inference scopes, provisioned throughput, the price, the surfaces
 * and their capabilities), what each accepted model is granted (exact ARNs, never a wildcard) and where the
 * registry reaches the Lambdas. The grant's policy shape and sizes: claude-model-grant.test.ts; the whole app:
 * lib/app-inference-scope.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyAppAspects } from './app-aspects';
import { grantClaudeModels } from './claude-model-grant';
import {
  CUSTOM_MODELS_ENV, customModelArns, customModelsEnvValue, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_CUSTOM_MODELS, MAX_ENV_CHARS, parseCustomModels, readsCustomModelRegistry, type RegistryTarget,
} from './custom-models';

const ACCOUNT = '111111111111';
const US: RegistryTarget = { region: 'us-west-2', account: ACCOUNT, scope: 'global' };
const EU: RegistryTarget = { region: 'eu-central-1', account: ACCOUNT, scope: 'eu' };
const EU_DESTINATIONS = ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'];
const ALL_CAPABILITIES = { tools: true, documents: true, json: true, temperature: true };

/** A valid in-Region Bedrock model entry, with `overrides`. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  key: 'nova', id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', kind: 'bedrock', surfaces: ['documents'],
  eu: false, capabilities: ALL_CAPABILITIES, price: { in: 0.8, out: 3.2 }, ...overrides,
});
const IMPORTED_US = `arn:aws:bedrock:us-west-2:${ACCOUNT}:imported-model/abc123def456`;
const parse = (raw: unknown, target: RegistryTarget = US) => parseCustomModels(raw, target);
const one = (overrides: Record<string, unknown>, target: RegistryTarget = US) => parse([entry(overrides)], target);

describe('parseCustomModels: off by default', () => {
  it.each([undefined, null, '', '[]', []])('reads %j as no model', (raw) => {
    expect(parse(raw)).toStrictEqual([]);
  });

  it('reads the CLI string and a cdk.context.json list alike, filling the defaults', () => {
    const [fromString] = parse(JSON.stringify([entry()]));
    expect(fromString).toStrictEqual({
      key: 'nova', id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', kind: 'bedrock', source: 'model',
      surfaces: ['documents'], eu: false, regions: ['us-west-2'], capabilities: ALL_CAPABILITIES,
      price: { in: 0.8, out: 3.2 }, contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    expect(parse([entry()])).toStrictEqual([fromString]);
  });

  it.each([['{not json', /not valid JSON/], ['{"key":"x"}', /a JSON list of models/]])('refuses the value %s', (raw, error) => {
    expect(() => parse(raw)).toThrow(error);
  });
});

describe('parseCustomModels: the id by kind', () => {
  it.each([
    ['an in-Region model', 'amazon.nova-pro-v1:0', 'model', ['us-west-2']],
    ['a us. profile with its Regions', 'us.meta.llama3-3-70b-instruct-v1:0', 'profile', ['us-east-1', 'us-east-2', 'us-west-2']],
    ['a global. profile', 'global.amazon.nova-2-lite-v1:0', 'profile', []],
  ])('accepts %s', (_name, id, source, regions) => {
    const overrides = id.startsWith('us.') ? { id, regions } : { id };
    expect(one(overrides)[0]).toMatchObject({ source, regions });
  });

  it('accepts an imported model of the deployment\'s own account and Region', () => {
    expect(one({ kind: 'imported', id: IMPORTED_US })[0]).toMatchObject({ source: 'imported', regions: ['us-west-2'] });
  });

  it.each([
    ['provisioned throughput', { id: `arn:aws:bedrock:us-west-2:${ACCOUNT}:provisioned-model/abc` }, /provisioned throughput is refused/],
    ['a fine-tuned custom model', { id: `arn:aws:bedrock:us-west-2:${ACCOUNT}:custom-model/amazon.nova/abc` }, /fine-tuned custom model/],
    ['an application profile', { id: `arn:aws:bedrock:us-west-2:${ACCOUNT}:application-inference-profile/x1` }, /application inference profile/],
    ['an ARN as a bedrock id', { id: `arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0` }, /model id or system inference-profile id/],
    ['an id with no provider', { id: 'nova' }, /model id or system inference-profile id/],
    ['an imported model in another Region', { kind: 'imported', id: IMPORTED_US.replace('us-west-2', 'us-east-1') }, /a model in another Region is refused/],
    ['an imported model of another account', { kind: 'imported', id: IMPORTED_US.replace(ACCOUNT, '222222222222') }, /not the deployment's/],
    ['an imported model in another partition', { kind: 'imported', id: IMPORTED_US.replace('arn:aws:', 'arn:aws-cn:') }, /partition aws-cn/],
    ['an imported model named by its id', { kind: 'imported', id: 'abc123def456' }, /named by its ARN/],
    ['a Claude model of the allowlist', { id: 'global.anthropic.claude-sonnet-5-5' }, /on the Claude or web search allowlist/],
    ['its eu. twin', { id: 'eu.anthropic.claude-sonnet-5-5' }, /on the Claude or web search allowlist/],
    ['a web search GPT model', { id: 'openai.gpt-5.6-luna' }, /on the Claude or web search allowlist/],
    ['a us. profile without its Regions', { id: 'us.meta.llama3-3-70b-instruct-v1:0' }, /declare the us\. profile's destination Regions/],
    ['Regions that leave out the app Region', { id: 'us.meta.llama3-3-70b-instruct-v1:0', regions: ['us-east-1'] }, /must include the app Region us-west-2/],
    ['Regions on an in-Region model', { regions: ['us-west-2'] }, /only for a geographic profile/],
  ])('refuses %s', (_name, overrides, error) => {
    expect(() => one(overrides)).toThrow(error);
  });
});

describe('parseCustomModels: data residency', () => {
  it('accepts, under inferenceScope=eu, an eu. profile (the EU destination table) and an in-Region model, both eu: true', () => {
    const models = parse([
      entry({ key: 'novaeu', id: 'eu.amazon.nova-pro-v1:0', eu: true }),
      entry({ key: 'imported', kind: 'imported', id: `arn:aws:bedrock:eu-central-1:${ACCOUNT}:imported-model/abc123`, eu: true }),
    ], EU);
    expect(models.map((model) => model.regions)).toStrictEqual([EU_DESTINATIONS, ['eu-central-1']]);
  });

  it.each([
    ['a model without eu: true', { id: 'eu.amazon.nova-pro-v1:0' }, /needs `"eu": true` on every custom model/],
    ['a global. profile', { id: 'global.amazon.nova-2-lite-v1:0', eu: true }, /global\. profile is refused under -c inferenceScope=eu/],
    ['a us. profile', { id: 'us.amazon.nova-pro-v1:0', eu: true, regions: ['eu-central-1'] }, /us\. profile is refused under -c inferenceScope=eu/],
  ])('refuses, under inferenceScope=eu, %s', (_name, overrides, error) => {
    expect(() => one(overrides, EU)).toThrow(error);
  });

  it.each([
    ['an in-Region model outside the EU', {}, US],
    ['a global. profile', { id: 'global.amazon.nova-2-lite-v1:0' }, US],
    ['an eu. profile from a Region with none', { id: 'eu.amazon.nova-pro-v1:0' }, US],
  ])('refuses eu: true on %s', (_name, overrides, target) => {
    expect(() => one({ ...overrides, eu: true }, target)).toThrow(/"eu": true|EU source Region/);
  });

  it('accepts eu: true on an in-Region model of an EU Region under the global scope', () => {
    expect(one({ eu: true }, { ...EU, scope: 'global' })[0]?.regions).toStrictEqual(['eu-central-1']);
  });
});

describe('parseCustomModels: price, surfaces and capabilities', () => {
  it.each([
    ['no price', { price: undefined }],
    ['half a price', { price: { in: 1 } }],
    ['a negative price', { price: { in: -1, out: 1 } }],
    ['a surface of its own family', { surfaces: ['web_reviews_search'] }],
    ['no surface', { surfaces: [] }],
    ['an unknown field', { endpoint: 'https://example.com' }],
    ['a key with capitals', { key: 'Nova' }],
    ['a missing capability', { capabilities: { tools: true, documents: true, json: true } }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => one(overrides)).toThrow(/-c customModels: model 1/);
  });

  it.each([
    ['chat without tools', { surfaces: ['chat'], capabilities: { ...ALL_CAPABILITIES, tools: false } }, /chat call tools/],
    ['the plan steps without tools', { surfaces: ['agent_worker'], capabilities: { ...ALL_CAPABILITIES, tools: false } }, /agent_worker call tools/],
    ['enrichment without JSON', { surfaces: ['enrichment', 'prototype'], capabilities: { ...ALL_CAPABILITIES, json: false } }, /enrichment parse JSON/],
    ['a surface twice', { surfaces: ['prototype', 'prototype'] }, /listed twice/],
    ['an answer larger than the window', { contextWindow: 8_000, maxOutputTokens: 16_000 }, /larger than contextWindow/],
  ])('refuses %s', (_name, overrides, error) => {
    expect(() => one(overrides)).toThrow(error);
  });

  it('lets a model without tools or JSON serve the prototype builder', () => {
    expect(one({ surfaces: ['prototype'], capabilities: { tools: false, documents: false, json: false, temperature: false } })).toHaveLength(1);
  });

  it(`refuses more than ${MAX_CUSTOM_MODELS} models, a repeated key and a repeated id`, () => {
    const many = Array.from({ length: MAX_CUSTOM_MODELS + 1 }, (_, i) => entry({ key: `m${i}`, id: `amazon.nova-${i}-v1:0` }));
    expect(() => parse(many)).toThrow(/at most 4 models/);
    expect(() => parse([entry(), entry({ id: 'amazon.nova-lite-v1:0' })])).toThrow(/key nova is used twice/);
    expect(() => parse([entry(), entry({ key: 'other' })])).toThrow(/id amazon.nova-pro-v1:0 is used twice/);
  });

  it('refuses a registry too large for a Lambda environment', () => {
    const long = (i: number) => entry({
      key: `m${i}`, id: `us.example.${'a-long-model-name-'.repeat(8)}${i}-v1:0`, label: 'L'.repeat(60),
      surfaces: ['documents', 'prototype', 'enrichment', 'utility', 'memory', 'agent_orchestrator', 'agent_reviewer', 'agent_persona'],
      regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'ca-west-1', 'mx-central-1', 'us-west-3'],
    });
    expect(() => parse([0, 1, 2, 3].map(long))).toThrow(/too large for a Lambda environment/);
    expect(customModelsEnvValue(parse([0, 1].map((i) => entry({ key: `m${i}`, id: `amazon.nova-${i}-v1:0` })))).length)
      .toBeLessThan(MAX_ENV_CHARS);
  });
});

describe('the env value the runtimes read', () => {
  // lambda/shared/test/test_custom_models.py and the stream Lambda's custom-models.test.ts read this file.
  const fixture = z.array(z.record(z.string(), z.unknown()))
    .parse(JSON.parse(readFileSync(join(__dirname, '..', 'test-support', 'custom-models-env.json'), 'utf8')));

  it('is what the synth writes for the same registry', () => {
    // The registry as an owner writes it: a kind instead of the source, and Regions only for the us. profile.
    const registry = fixture.map(({ source, regions, ...entry }) => ({
      ...entry, kind: source === 'imported' ? 'imported' : 'bedrock', ...(source === 'profile' ? { regions } : {}),
    }));
    expect(JSON.parse(customModelsEnvValue(parse(registry)))).toStrictEqual(fixture);
  });
});

describe('customModelArns', () => {
  const stackIn = (region: string) => new cdk.Stack(new cdk.App(), 'S', { env: { account: ACCOUNT, region } });

  it('names an in-Region model and an imported model by their ARNs in the app Region and account', () => {
    const stack = stackIn('us-west-2');
    const [model, imported] = parse([entry(), entry({ key: 'mine', kind: 'imported', id: IMPORTED_US })]);
    expect([model, imported].map((m) => m && customModelArns(m, stack))).toStrictEqual([
      { kind: 'direct', arn: 'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0' },
      { kind: 'direct', arn: IMPORTED_US },
    ]);
  });

  it('names a global. profile in the three documented parts and a geographic profile in each declared Region', () => {
    const stack = stackIn('us-west-2');
    const [global, us] = parse([
      entry({ id: 'global.amazon.nova-2-lite-v1:0' }),
      entry({ key: 'llama', id: 'us.meta.llama3-3-70b-instruct-v1:0', regions: ['us-east-1', 'us-west-2'] }),
    ]);
    expect([global, us].map((m) => m && customModelArns(m, stack))).toStrictEqual([
      { kind: 'profile', arns: {
        profile: `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/global.amazon.nova-2-lite-v1:0`,
        regionalModels: ['arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0'],
        globalModel: 'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0', requestingRegion: 'us-west-2',
      } },
      { kind: 'profile', arns: {
        profile: `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.meta.llama3-3-70b-instruct-v1:0`,
        regionalModels: ['us-east-1', 'us-west-2'].map((r) => `arn:aws:bedrock:${r}::foundation-model/meta.llama3-3-70b-instruct-v1:0`),
      } },
    ]);
  });
});

describe('the registry in the Lambda environment', () => {
  const FunctionsSchema = z.record(z.string(), z.object({
    Properties: z.object({ Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional() }),
  }));

  /** A model caller, a Claude-only one, a function that calls no model and one that reads the registry only. */
  function synth(context: Record<string, unknown>): Record<string, Record<string, unknown>> {
    const app = new cdk.App({ context });
    const stack = new cdk.Stack(app, 'Env', { env: { account: ACCOUNT, region: 'us-west-2' } });
    const fn = (id: string) => new lambda.Function(stack, id, {
      runtime: lambda.Runtime.PYTHON_3_14, handler: 'h.handler', code: lambda.Code.fromInline('def handler(e, c): pass'),
    });
    const caller = fn('Caller');
    const claudeOnly = fn('ClaudeOnly');
    fn('NoModel');
    readsCustomModelRegistry(fn('Reader'));
    if (caller.role === undefined || claudeOnly.role === undefined) throw new Error('functions without roles');
    grantClaudeModels(caller.role, 'invoke');
    grantClaudeModels(claudeOnly.role, 'invoke', { customModels: false });
    applyAppAspects(app, { auditRowTables: {} });
    const functions = FunctionsSchema.parse(Template.fromStack(stack).findResources('AWS::Lambda::Function'));
    return Object.fromEntries(Object.entries(functions)
      .map(([id, resource]) => [id.replace(/[0-9A-F]{8}$/, ''), resource.Properties.Environment?.Variables ?? {}]));
  }

  it('sets the checked registry on the functions whose role holds the custom grant, and on the readers', () => {
    const value = customModelsEnvValue(parse([entry()]));
    const env = synth({ customModels: JSON.stringify([entry()]) });
    expect(Object.fromEntries(Object.entries(env).map(([id, variables]) => [id, variables[CUSTOM_MODELS_ENV]])))
      .toStrictEqual({ Caller: value, ClaudeOnly: undefined, NoModel: undefined, Reader: value });
  });

  it('sets nothing without -c customModels', () => {
    expect(JSON.stringify(synth({}))).not.toContain(CUSTOM_MODELS_ENV);
  });

  it('keeps a Claude-only role off the custom models, on a twin policy set', () => {
    const app = new cdk.App({ context: { customModels: [entry()] } });
    const stack = new cdk.Stack(app, 'Twin', { env: { account: ACCOUNT, region: 'us-west-2' } });
    const role = new iam.Role(stack, 'Engineering', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    grantClaudeModels(role, 'invoke', { customModels: false });
    const policies = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies).every((id) => id.startsWith('ClaudeOnlyInvokePolicy'))).toBe(true);
    expect(JSON.stringify(policies)).not.toContain('amazon.nova');
  });
});
