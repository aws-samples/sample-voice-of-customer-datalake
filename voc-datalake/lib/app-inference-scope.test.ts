/**
 * `-c inferenceScope=eu` across the WHOLE app (docs/eu-deployment.md): every
 * Bedrock-calling Lambda is told to map `global.` → `eu.` at call time, every
 * Bedrock grant names only `eu.` inference profiles, avatars are switched off and
 * the web-search gateway is not deployed. The default (`global`) synth is pinned
 * byte-for-byte by app-baseline.test.ts, which is what proves the flag is opt-in.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { claudeRoleGrants, e2eProfileModels, IamPolicyResourceSchema, missingModelGrants } from './test-support/bedrock-grants';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from './test-support/synth-app';

const FunctionSchema = z.object({
  Type: z.literal('AWS::Lambda::Function'),
  Properties: z.object({
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }).optional(),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
  }),
});
const TemplateSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });

// An EU source Region of the eu. profiles: the grant lists that region's destination Regions.
const EU_REGION = 'eu-central-1';
const eu = synthApp({ inferenceScope: 'eu' }, EU_REGION);
afterAll(cleanupAssemblyDirs);

// Every template of the eu synth as one searchable text (for "nowhere" assertions).
const allTemplatesText = eu.stackNames.map((stack) => JSON.stringify(eu.template(stack))).join('\n');

const resourcesOf = (stack: string) => Object.entries(TemplateSchema.parse(eu.template(stack)).Resources);

/** Role logical ids (per stack) whose inline or managed policy may invoke a Bedrock model. */
function bedrockRoles(stack: string): Set<string> {
  return bedrockRolesOf(eu.template(stack));
}

/** {@link bedrockRoles} of one synthesized template. */
function bedrockRolesOf(template: unknown): Set<string> {
  return new Set(Object.values(TemplateSchema.parse(template).Resources).flatMap((resource) => {
    const policy = IamPolicyResourceSchema.safeParse(resource);
    if (!policy.success) return [];
    const invokes = policy.data.Properties.PolicyDocument.Statement
      .some((s) => s.Action.some((a) => a.startsWith('bedrock:InvokeModel')));
    return invokes ? (policy.data.Properties.Roles ?? []).map((role) => role.Ref) : [];
  }));
}

function bedrockFunctions(stack: string) {
  const roles = bedrockRoles(stack);
  return resourcesOf(stack).flatMap(([id, resource]) => {
    const fn = FunctionSchema.safeParse(resource);
    const roleId = fn.data?.Properties.Role?.['Fn::GetAtt'][0];
    return fn.success && roleId !== undefined && roles.has(roleId)
      ? [{ id, env: fn.data.Properties.Environment?.Variables ?? {} }]
      : [];
  });
}

describe('inferenceScope=eu', () => {
  it('finds the Bedrock callers it checks (processor, assistant stream, settings, …)', () => {
    const ids = eu.stackNames.flatMap((stack) => bedrockFunctions(stack).map((fn) => fn.id)).join(' ');
    expect(['FeedbackProcessor', 'ChatStreamApi', 'SettingsApi', 'ProductDocExtractorLambda']
      .filter((name) => !ids.includes(name))).toStrictEqual([]);
  });

  it('tells every Bedrock-calling Lambda BEDROCK_INFERENCE_SCOPE=eu and AVATARS_ENABLED=false', () => {
    const missing = eu.stackNames.flatMap((stack) => bedrockFunctions(stack)
      .filter((fn) => fn.env.BEDROCK_INFERENCE_SCOPE !== 'eu' || fn.env.AVATARS_ENABLED !== 'false')
      .map((fn) => `${stack}/${fn.id}`));
    expect(missing).toStrictEqual([]);
  });

  it('grants no global. inference profile anywhere, and the eu. profiles instead', () => {
    expect(allTemplatesText).not.toMatch(/inference-profile\/global\./);
    expect(allTemplatesText).toContain('inference-profile/eu.anthropic.claude-sonnet-5-5');
  });

  it('grants every Claude-invoking role the e2e profile models (Haiku 5.5 + its capacity fallback) as eu. profile and as foundation model in each destination Region', () => {
    const grants = claudeRoleGrants(eu);
    expect(grants.length).toBeGreaterThan(20);
    expect(missingModelGrants(grants, e2eProfileModels(), 'eu', EU_REGION)).toStrictEqual([]);
  });

  it('grants no Region-agnostic (global) foundation model and no Region wildcard on any Bedrock model', () => {
    expect(allTemplatesText).not.toContain('arn:aws:bedrock:::foundation-model/');
    expect(allTemplatesText).not.toMatch(/arn:aws:bedrock:\*/);
  });

  it('does not deploy the web-search gateway, nor hand any Lambda its URL', () => {
    expect(allTemplatesText).not.toContain('AWS::BedrockAgentCore::Gateway');
    expect(allTemplatesText).not.toContain('WEB_SEARCH_GATEWAY_URL');
  });
});

describe('inferenceScope validation', () => {
  it('rejects an unknown scope at synth', () => {
    expect(() => synthApp({ inferenceScope: 'us' })).toThrow(/Invalid -c inferenceScope="us"/);
  }, SYNTH_TIMEOUT_MS);

  it('rejects an explicit enableWebSearch=true with eu', () => {
    expect(() => synthApp({ inferenceScope: 'eu', enableWebSearch: true }, EU_REGION)).toThrow(/cannot be combined with inferenceScope=eu/);
  }, SYNTH_TIMEOUT_MS);

  it('rejects eu in a region with no eu. inference profiles (every Claude call would fail)', () => {
    expect(() => synthApp({ inferenceScope: 'eu' })).toThrow(/needs the app deployed to an EU source Region/);
  }, SYNTH_TIMEOUT_MS);
});

/**
 * `-c customModels` (7.65.00, lib/utils/custom-models.ts) in an EU deployment with the engineering agents: each
 * custom model is granted by its exact ARNs in the shared policies (an `eu.` profile through the profile in each
 * destination Region, an imported model in the app Region), the registry reaches every Bedrock caller but the
 * engineering runtime (Claude-only, on its twin policies), and nothing is a wildcard or provisioned throughput.
 */
describe('inferenceScope=eu with -c customModels', () => {
  const CAPABILITIES = { tools: true, documents: true, json: true, temperature: true };
  const IMPORTED = `arn:aws:bedrock:${EU_REGION}:111111111111:imported-model/abc123def456`;
  const registry = [
    { key: 'novaeu', id: 'eu.amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', kind: 'bedrock',
      surfaces: ['chat', 'documents', 'enrichment'], eu: true, capabilities: CAPABILITIES, price: { in: 0.8, out: 3.2 } },
    { key: 'ownmodel', id: IMPORTED, label: 'Example imported model', kind: 'imported', surfaces: ['memory'], eu: true,
      capabilities: { tools: false, documents: false, json: true, temperature: false }, price: { in: 0.5, out: 1.5 } },
  ];
  const custom = synthApp({ inferenceScope: 'eu', engineeringAgents: true, customModels: JSON.stringify(registry) }, EU_REGION);
  const customText = custom.stackNames.map((stack) => JSON.stringify(custom.template(stack))).join('\n');
  const customResources = (stack: string) => Object.entries(TemplateSchema.parse(custom.template(stack)).Resources);
  const ManagedPolicySchema = z.object({
    Type: z.literal('AWS::IAM::ManagedPolicy'),
    Properties: z.object({ Roles: z.array(z.object({ Ref: z.string() })).optional(), PolicyDocument: z.unknown() }),
  });
  /** `<stack>/<role>` of every role attaching a policy whose logical id starts with `prefix`, with those policies. */
  const rolesAttaching = (prefix: string) => new Map<string, string>(custom.stackNames.flatMap((stack) => customResources(stack)
    .flatMap(([id, resource]) => {
      const policy = ManagedPolicySchema.safeParse(resource);
      return policy.success && id.startsWith(prefix)
        ? (policy.data.Properties.Roles ?? []).map((role) => [`${stack}/${role.Ref}`, JSON.stringify(policy.data.Properties.PolicyDocument)] as const)
        : [];
    })));

  it('grants the eu. profile in each destination Region and the imported model by its ARN', () => {
    expect(customText).toContain('inference-profile/eu.amazon.nova-pro-v1:0');
    for (const region of ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3']) {
      expect(customText).toContain(`arn:aws:bedrock:${region}::foundation-model/amazon.nova-pro-v1:0`);
    }
    expect(customText).toContain(`"${IMPORTED}"`);
  });

  it('grants no wildcard model, no global. profile and no provisioned throughput anywhere', () => {
    expect(customText).not.toContain('foundation-model/*');
    expect(customText).not.toMatch(/inference-profile\/global\.|arn:aws:bedrock:\*|bedrock:::foundation-model/);
    expect(customText).not.toMatch(/ProvisionedModelThroughput|provisioned-model/);
  });

  it('keeps the engineering runtime on its Claude-only twin, with no custom model', () => {
    const twins = rolesAttaching('ClaudeOnly');
    expect(twins.size).toBeGreaterThan(0);
    const shared = rolesAttaching('ClaudeInvoke');
    expect([...twins.keys()].filter((role) => shared.has(role))).toStrictEqual([]);
    expect([...twins.values()].filter((document) => /amazon\.nova|imported-model/.test(document))).toStrictEqual([]);
  });

  it('gives the registry to every Bedrock-calling Lambda but a Claude-only role\'s, and to its two readers only', () => {
    const twins = rolesAttaching('ClaudeOnly');
    const functions = custom.stackNames.flatMap((stack) => customResources(stack).flatMap(([id, resource]) => {
      const fn = FunctionSchema.safeParse(resource);
      if (!fn.success) return [];
      const role = fn.data.Properties.Role?.['Fn::GetAtt'][0];
      return [{ id: `${stack}/${id}`, role: role === undefined ? undefined : `${stack}/${role}`, env: fn.data.Properties.Environment?.Variables ?? {} }];
    }));
    const callers = new Set(custom.stackNames.flatMap((stack) => [...bedrockRolesOf(custom.template(stack))].map((role) => `${stack}/${role}`)));
    const missing = functions.filter((fn) => fn.role !== undefined && callers.has(fn.role) && !twins.has(fn.role) && fn.env.CUSTOM_MODELS === undefined);
    const leaked = functions.filter((fn) => fn.role !== undefined && twins.has(fn.role) && fn.env.CUSTOM_MODELS !== undefined);
    expect([missing.map((fn) => fn.id), leaked.map((fn) => fn.id)]).toStrictEqual([[], []]);
    // The readers that call no model: the cost rollup (prices) and the logs API (System → Environment).
    const readers = functions.filter((fn) => fn.role !== undefined && !callers.has(fn.role) && fn.env.CUSTOM_MODELS !== undefined);
    expect(readers.map((fn) => fn.id.replace(/[0-9A-F]{8}$/, '')).sort((a, b) => a.localeCompare(b)))
      .toStrictEqual(['VocApiStack/LogsApi', 'VocProcessingStack/CostRollupWorkerCostRollup']);
  });

  it('leaves the avatar image model\'s grant as it is without the key', () => {
    const imageStatements = (text: string) => text.match(/\{[^{}]*foundation-model\/stability\.[^{}]*\}/g) ?? [];
    expect(imageStatements(customText)).toStrictEqual(imageStatements(allTemplatesText));
  });

  it('refuses a global. custom model at synth', () => {
    const global = [{ ...registry[0], key: 'lite', id: 'global.amazon.nova-2-lite-v1:0' }];
    expect(() => synthApp({ inferenceScope: 'eu', customModels: JSON.stringify(global) }, EU_REGION))
      .toThrow(/global\. profile is refused under -c inferenceScope=eu/);
  }, SYNTH_TIMEOUT_MS);
});
